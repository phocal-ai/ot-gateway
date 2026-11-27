/**
 * `ot-gateway write`: the point and value checked against the config, then a command through a real broker over
 * TCP, answered by a scripted gateway or by the gateway itself.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer"
import { describe, expect, it } from "@effect/vitest"
import { type GatewayConfig, parseConfig } from "@ot-gateway/core"
import { type BrokerControl, type InboundMessage, makeBrokerControl, serveMqtt } from "@ot-gateway/mqtt"
import { Effect, Fiber } from "effect"
import { brokerClient, firstDialOf } from "../src/Broker.ts"
import { runGateway } from "../src/Gateway.ts"
import {
  findPoint,
  formatWritten,
  outcomeHint,
  parseTarget,
  parseValue,
  WriteFailed,
  writePoint
} from "../src/Write.ts"

const devices = [
  {
    id: "room",
    protocol: "bacnet-ip",
    deviceInstance: 1001,
    address: "127.0.0.1:47899",
    points: [
      {
        id: "setpoint",
        name: "Setpoint",
        unit: "unit:DEG_C",
        objectType: "analog-value",
        instance: 1,
        writable: true,
        limits: { min: 15, max: 30 }
      },
      { id: "heating", name: "Heating", objectType: "binary-value", instance: 1, writable: true },
      { id: "temperature", name: "Temperature", unit: "unit:DEG_C", objectType: "analog-input", instance: 1 }
    ]
  },
  {
    id: "meter",
    protocol: "modbus-tcp",
    host: "127.0.0.1",
    port: 1,
    points: [
      {
        id: "power",
        name: "Power limit",
        table: "holding",
        address: 100,
        dataType: "float32",
        writable: true,
        limits: { min: 0, max: 10 }
      }
    ]
  }
]

const configAt = (url: string, version: "auto" | "3.1.1" = "auto", only?: "meter") =>
  parseConfig(
    JSON.stringify({
      site: "s",
      building: "b",
      mqtt: { url, version },
      devices: only === undefined ? devices : devices.filter((device) => device.id === only)
    })
  )

const config = (version: "auto" | "3.1.1" = "auto") => configAt("mqtt://127.0.0.1:1", version)

/** A broker on a free port for the current scope, and a config pointing at it. */
const brokerAndConfig = (control: BrokerControl, version: "auto" | "3.1.1" = "auto", only?: "meter") =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
    yield* serveMqtt(server, control).pipe(Effect.forkScoped)
    const port = server.address._tag === "UnixPathAddress" ? 0 : server.address.port
    return yield* configAt(`mqtt://127.0.0.1:${port}`, version, only)
  })

/** A gateway stand-in: answers every command with `answer`, echoing its correlation data, after `before` if any. */
const responder = (
  gateway: GatewayConfig,
  answer: (command: InboundMessage) => string | undefined,
  before?: (
    command: InboundMessage
  ) => ReadonlyArray<{ readonly payload: string; readonly correlationData?: Uint8Array }>
) =>
  Effect.gen(function* () {
    const commands: Array<InboundMessage> = []
    let client: Effect.Success<ReturnType<typeof brokerClient>> | undefined
    client = yield* brokerClient(gateway.mqtt, "responder", {
      subscriptions: [{ filter: "s/b/+/+/$set", qos: 1 }],
      onMessage: (message) =>
        Effect.gen(function* () {
          commands.push(message)
          if (client === undefined) return
          for (const extra of before?.(message) ?? []) {
            yield* client.publish(`${message.topic}/result`, extra.payload, {
              qos: 1,
              ...(extra.correlationData === undefined ? {} : { correlationData: extra.correlationData })
            })
          }
          const payload = answer(message)
          if (payload === undefined) return
          yield* client.publish(`${message.topic}/result`, payload, {
            qos: 1,
            ...(message.correlationData === undefined ? {} : { correlationData: message.correlationData })
          })
        }).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid)
    })
    yield* firstDialOf(client, gateway.mqtt)
    return commands
  })

const failure = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => (error instanceof WriteFailed ? error : undefined)))

describe("parseTarget", () => {
  it("takes device/point and nothing else", () => {
    expect(parseTarget("room/setpoint")).toEqual({ device: "room", point: "setpoint" })
    expect(parseTarget("room")).toBeUndefined()
    expect(parseTarget("s/b/room/setpoint")).toBeUndefined()
    expect(parseTarget("room/")).toBeUndefined()
  })
})

describe("findPoint and parseValue", () => {
  it.effect("refuses an unknown or read-only point, naming the writable ones", () =>
    Effect.gen(function* () {
      const gateway = yield* config()
      const unknown = findPoint(gateway, { device: "room", point: "nope" })
      expect(unknown).toMatchObject({ code: "unknown-point", written: false })
      expect(unknown instanceof WriteFailed && unknown.hint).toBe(
        "writable points: room/setpoint, room/heating, meter/power"
      )
      const readOnly = findPoint(gateway, { device: "room", point: "temperature" })
      expect(readOnly).toMatchObject({ code: "not-writable", written: false })
      expect(readOnly instanceof WriteFailed && readOnly.hint).toContain(
        "ot-gateway points allow-commands room/temperature"
      )
    })
  )

  it.effect("reads the value as the point takes it, and checks it as the guard does", () =>
    Effect.gen(function* () {
      const gateway = yield* config()
      const point = (id: string) => {
        const found = findPoint(gateway, { device: id === "power" ? "meter" : "room", point: id })
        if (found instanceof WriteFailed) throw found
        return found
      }
      const setpoint = point("setpoint")
      const heating = point("heating")
      const power = point("power")
      expect(parseValue(setpoint.device, setpoint.point, "21.5")).toBe(21.5)
      expect(parseValue(setpoint.device, setpoint.point, "null")).toBeNull()
      expect(parseValue(heating.device, heating.point, "on")).toBe(true)
      expect(parseValue(heating.device, heating.point, "0")).toBe(false)
      expect(parseValue(setpoint.device, setpoint.point, "40")).toMatchObject({
        code: "out-of-range",
        message: "room/setpoint: 40 is outside 15 to 30",
        hint: "room/setpoint takes a number from 15 to 30 °C, or null to release the priority slot; to allow more, widen its limits in the config and restart the gateway"
      })
      expect(parseValue(setpoint.device, setpoint.point, "warm")).toMatchObject({ code: "wrong-type" })
      expect(parseValue(setpoint.device, setpoint.point, "Infinity")).toMatchObject({ code: "wrong-type" })
      expect(parseValue(setpoint.device, setpoint.point, "")).toMatchObject({ code: "wrong-type" })
      expect(parseValue(heating.device, heating.point, "21")).toMatchObject({ code: "wrong-type" })
      // Only a BACnet point has a priority slot to release.
      expect(parseValue(power.device, power.point, "null")).toMatchObject({ code: "wrong-type" })
    })
  )

  it("says what to do after each of the gateway's reasons", () => {
    expect(outcomeHint("timeout", "room/setpoint", "s/b/room/setpoint")).toContain("may have applied it")
    expect(outcomeHint("device-unavailable", "room/setpoint", "s/b/room/setpoint")).toContain("ot-gateway status")
    expect(outcomeHint("not-writable", "room/setpoint", "s/b/room/setpoint")).toContain("config differs")
  })
})

describe("ot-gateway write", () => {
  it.live("sends the command on $set with correlation data and reports the gateway's result", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      const gateway = yield* brokerAndConfig(control)
      const commands = yield* responder(gateway, () => JSON.stringify({ status: "written", value: 21.5, ts: 1 }))
      const report = yield* writePoint(gateway, { device: "room", point: "setpoint" }, "21.5")
      expect(report).toMatchObject({
        ok: true,
        status: "written",
        device: "room",
        point: "setpoint",
        topic: "s/b/room/setpoint",
        value: 21.5,
        unit: "unit:DEG_C"
      })
      expect(formatWritten(report)).toMatch(/^✓ room\/setpoint = 21\.5 °C \(written in \d+ ms\)$/)
      expect(commands).toHaveLength(1)
      expect(commands[0]).toMatchObject({ topic: "s/b/room/setpoint/$set", payload: '{"value":21.5}', retain: false })
      expect(commands[0]?.correlationData?.length).toBe(16)
    }).pipe(Effect.scoped)
  )

  it.live("ignores results meant for other commands, and fails with the gateway's reason and a hint", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      const gateway = yield* brokerAndConfig(control)
      yield* responder(
        gateway,
        () => JSON.stringify({ status: "failed", reason: "timeout", message: "no answer within 10s", ts: 1 }),
        () => [
          { payload: JSON.stringify({ status: "written", value: 20, ts: 1 }), correlationData: new Uint8Array([1, 2]) }
        ]
      )
      const error = yield* failure(writePoint(gateway, { device: "room", point: "setpoint" }, "20"))
      expect(error).toMatchObject({
        code: "timeout",
        written: "unknown",
        message: "room/setpoint: failed by the gateway: no answer within 10s"
      })
      expect(error?.hint).toContain("may have applied it")
    }).pipe(Effect.scoped)
  )

  it.live("sends nothing for a value the config refuses", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      const gateway = yield* brokerAndConfig(control)
      const commands = yield* responder(gateway, () => undefined)
      const error = yield* failure(writePoint(gateway, { device: "room", point: "setpoint" }, "99"))
      expect(error).toMatchObject({ code: "out-of-range", written: false })
      expect(commands).toEqual([])
    }).pipe(Effect.scoped)
  )

  it.live("over MQTT 3.1.1, takes the first result after the command", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.speaksMqtt5 = false
      const gateway = yield* brokerAndConfig(control, "3.1.1")
      const commands = yield* responder(gateway, () =>
        JSON.stringify({ status: "rejected", reason: "out-of-range", message: "16 is outside 18 to 30", ts: 1 })
      )
      const error = yield* failure(writePoint(gateway, { device: "room", point: "setpoint" }, "16"))
      expect(error).toMatchObject({ code: "out-of-range", written: false })
      expect(error?.hint).toContain("running gateway's limits")
      expect(commands[0]?.correlationData).toBeUndefined()
    }).pipe(Effect.scoped)
  )

  it.live("says whether a failed write may have reached the device", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      const gateway = yield* brokerAndConfig(control)
      let reason = "invalid-response"
      yield* responder(gateway, () => JSON.stringify({ status: "failed", reason, message: "garbled", ts: 1 }))
      const garbled = yield* failure(writePoint(gateway, { device: "room", point: "setpoint" }, "20"))
      expect(garbled).toMatchObject({ code: "invalid-response", written: "unknown" })
      reason = "device-unavailable"
      const down = yield* failure(writePoint(gateway, { device: "room", point: "setpoint" }, "20"))
      expect(down).toMatchObject({ code: "device-unavailable", written: false })
    }).pipe(Effect.scoped)
  )

  it.live("fails with command-refused when the broker turns the command away", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      control.refusedTopics.add("s/b/room/setpoint/$set")
      const gateway = yield* brokerAndConfig(control)
      const error = yield* failure(writePoint(gateway, { device: "room", point: "setpoint" }, "20"))
      expect(error).toMatchObject({ code: "command-refused", written: false })
      expect(error?.hint).toContain("s/b/+/+/$set")
    }).pipe(Effect.scoped)
  )

  it.live("fails with no-result when no gateway answers in time", () =>
    Effect.gen(function* () {
      const control = makeBrokerControl()
      const gateway = yield* brokerAndConfig(control)
      const error = yield* failure(
        writePoint(gateway, { device: "room", point: "heating" }, "on", { timeout: "300 millis" })
      )
      expect(error).toMatchObject({ code: "no-result", written: "unknown" })
      expect(error?.hint).toContain("ot-gateway status")
      expect(control.messages.find((message) => message.topic === "s/b/room/heating/$set")?.payload).toBe(
        '{"value":true}'
      )
    }).pipe(Effect.scoped)
  )

  it.live(
    "gets its answer from the gateway's own command guard",
    () =>
      Effect.gen(function* () {
        const control = makeBrokerControl()
        const gateway = yield* brokerAndConfig(control, "auto", "meter")
        const running = yield* runGateway(gateway).pipe(Effect.forkScoped)
        // The gateway subscribes for commands once connected; until then a command goes nowhere.
        const subscribed = () =>
          [...control.subscribers].some((subscriber) =>
            subscriber.subscriptions.some((subscription) => subscription.filter === "s/b/+/+/$set")
          )
        yield* Effect.gen(function* () {
          while (!subscribed()) yield* Effect.sleep("20 millis")
        }).pipe(Effect.timeout("4 seconds"))
        const error = yield* failure(writePoint(gateway, { device: "meter", point: "power" }, "5"))
        // Nothing listens at the meter's address: the guard passed the command on, and the device was not there.
        expect(["device-unavailable", "connection"]).toContain(error?.code)
        expect(error?.message).toMatch(/^meter\/power: failed by the gateway: /)
        yield* Fiber.interrupt(running)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 15_000 }
  )
})
