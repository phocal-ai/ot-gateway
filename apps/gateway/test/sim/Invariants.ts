/**
 * What must hold after a simulated run, whatever faults it went through. Each
 * check returns the violations it found, as sentences a failing test prints.
 */
import { healthTopic } from "@plenum/core"
import { Schema } from "effect"
import type { SimulationRun } from "./Simulation.ts"

/** Messages the drainer may have in flight when a connection breaks (`BufferedPublisher.ts`). */
const IN_FLIGHT = 16

/** Faults after which values in flight may be sent again: anything that breaks the broker connection. */
const reconnectingFaults = new Set(["broker-crash", "broker-partition", "gateway-partition", "gateway-restart"])

/** Warnings and errors allowed per fault (a device or a connection failing and recovering) and for a quiet run. */
const PROBLEMS_PER_FAULT = 12
const PROBLEMS_BASELINE = 10

/** The parts of a health message and of a value message the checks read; MQTT payloads are decoded, not trusted. */
const HealthMessage = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    ts: Schema.optionalKey(Schema.Number),
    devices: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ status: Schema.String })))
  })
)
const ValueMessage = Schema.fromJsonString(Schema.Struct({ ts: Schema.Number }))
const decodeHealth = Schema.decodeUnknownSync(HealthMessage)
const decodeValue = Schema.decodeUnknownSync(ValueMessage)

const keyOf = (message: { readonly topic: string; readonly payload: string }) => `${message.topic} ${message.payload}`

export interface Verdict {
  readonly violations: ReadonlyArray<string>
  readonly summary: Record<string, number>
}

export const checkInvariants = (run: SimulationRun, totalMs: number): Verdict => {
  const violations: Array<string> = []
  const values = run.received.filter((message) => !message.retain)

  // 1. No value the gateway accepted is lost: it reaches the broker, through every outage and restart.
  const delivered = new Map<string, number>()
  for (const message of values) delivered.set(keyOf(message), (delivered.get(keyOf(message)) ?? 0) + 1)
  const lost = run.accepted.filter((message) => !delivered.has(keyOf(message)))
  if (lost.length > 0) {
    violations.push(
      `${lost.length} accepted value(s) never reached the broker, first: ${lost[0] === undefined ? "" : keyOf(lost[0])}`
    )
  }

  // 2. Per topic, values first arrive in the order they were accepted (resends may repeat older ones later).
  const acceptedOrder = new Map<string, Map<string, number>>()
  for (const message of run.accepted) {
    const order = acceptedOrder.get(message.topic) ?? new Map<string, number>()
    if (!order.has(message.payload)) order.set(message.payload, order.size)
    acceptedOrder.set(message.topic, order)
  }
  const seen = new Set<string>()
  const lastIndex = new Map<string, number>()
  let outOfOrder = 0
  let firstOutOfOrder = ""
  for (const message of values) {
    if (seen.has(keyOf(message))) continue
    seen.add(keyOf(message))
    const index = acceptedOrder.get(message.topic)?.get(message.payload)
    if (index === undefined) continue
    if (index < (lastIndex.get(message.topic) ?? -1)) {
      outOfOrder++
      firstOutOfOrder ||= keyOf(message)
    }
    lastIndex.set(message.topic, index)
  }
  if (outOfOrder > 0) violations.push(`${outOfOrder} value(s) arrived before older ones, first: ${firstOutOfOrder}`)

  // 3. Duplicates only from messages in flight when a connection broke.
  const duplicates = [...delivered.values()].reduce((sum, count) => sum + count - 1, 0)
  const breaks = run.faults.filter((fault) => reconnectingFaults.has(fault.kind)).length
  if (duplicates > IN_FLIGHT * (breaks + 1)) {
    violations.push(`${duplicates} duplicate(s), more than ${IN_FLIGHT} per broken connection (${breaks + 1})`)
  }

  // 4. The outbox drained.
  if (run.backlog !== 0) violations.push(`${run.backlog} row(s) left in the outbox`)

  // 5. The last health message says online, every device ok, and is current.
  const topic = healthTopic(run.config.site, run.config.building, run.config.id)
  const health = run.received
    .filter((message) => message.topic === topic)
    .map((message) => decodeHealth(message.payload))
    .findLast((message) => message.status === "online")
  if (health === undefined) violations.push("no online health message")
  else {
    const notOk = run.config.devices.map((device) => device.id).filter((id) => health.devices?.[id]?.status !== "ok")
    if (notOk.length > 0) violations.push(`not ok in the last health message: ${notOk.join(", ")}`)
    if ((health.ts ?? 0) < totalMs - 3 * run.config.healthIntervalMs) {
      violations.push(`the last health message is from ${health.ts}, the run ended at ${totalMs}`)
    }
  }

  // 6. Every device delivers values again by the end.
  const recentFrom = totalMs - 5 * 60_000
  for (const device of run.config.devices) {
    const prefix = `${run.config.site}/${run.config.building}/${device.id}/`
    const recent = values.some(
      (message) => message.topic.startsWith(prefix) && decodeValue(message.payload).ts >= recentFrom
    )
    if (!recent) violations.push(`${device.id} delivered nothing in the last 5 minutes`)
  }

  // 7. No sockets leak: while running, one connection per Modbus device and the broker; none once stopped.
  const modbus = run.config.devices.filter((device) => device.protocol === "modbus-tcp").length
  if (run.gatewayEnds.running > modbus + 1) {
    violations.push(`the gateway held ${run.gatewayEnds.running} connections, more than ${modbus + 1}`)
  }
  if (run.gatewayEnds.stopped !== 0) violations.push(`${run.gatewayEnds.stopped} connection(s) open after stopping`)
  const bacnet = run.config.devices.filter((device) => device.protocol === "bacnet-ip").length
  if (run.udpEndpointsAfterStop !== bacnet) {
    violations.push(`${run.udpEndpointsAfterStop} UDP endpoint(s) after stopping, expected the ${bacnet} devices'`)
  }

  // 8. The log budget: problems are logged when they start and end, not while they last.
  const budget = PROBLEMS_BASELINE + PROBLEMS_PER_FAULT * run.faults.length
  if (run.problems.length > budget) {
    const counts = new Map<string, number>()
    for (const line of run.problems) counts.set(line, (counts.get(line) ?? 0) + 1)
    const top = [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, 3)
    violations.push(
      `${run.problems.length} warnings and errors for ${run.faults.length} faults (budget ${budget}); most: ${top.map(([line, count]) => `${count}× ${line}`).join("; ")}`
    )
  }

  return {
    violations,
    summary: {
      faults: run.faults.length,
      accepted: run.accepted.length,
      delivered: values.length,
      duplicates,
      problems: run.problems.length,
      datagramsLost: run.datagramsLost
    }
  }
}
