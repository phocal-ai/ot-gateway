/**
 * What the status page sets devices up with (`/api/test/*`, `/api/import/*`, the contract in
 * `@ot-gateway/api`'s Setup.ts): a broker or a device tested with settings not saved yet, and the devices of an
 * uploaded points list or EDE file checked row by row and added through the config editor (ETag, backup, apply,
 * rollback).
 *
 * Tests only read. A broker test connects with a client id of its own (Broker.ts, as `ot-gateway broker`); a
 * device test opens a connection of its own, so the gateway's own connections are not touched, and reads the points
 * asked for once. One test runs at a time, each within a deadline, and the same device or broker is not tested
 * again within a moment. The edit guard has passed every request before it gets here.
 */
import {
  type BrokerTest,
  type ConfigIssue,
  type ImportApplied,
  type ImportCheck,
  type ImportDevice,
  ImportInvalid,
  MAX_TEST_POINTS,
  type PointTest,
  type ReadFailure,
  type ReadTest,
  TestBusy,
  TestInvalid
} from "@ot-gateway/api"
import { makeBacnetDriverFromClient, makeBacnetNetwork } from "@ot-gateway/bacnet"
import {
  applyScaling,
  type BacnetDevice,
  type Device,
  type Driver,
  type DriverError,
  type GatewayConfig,
  type ModbusDevice,
  monotonicMillis,
  type Network,
  type Reading
} from "@ot-gateway/core"
import { endpointOf, endpointText, makeModbusClient, makeModbusDriverFromClient } from "@ot-gateway/modbus"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Duration, Effect, type FileSystem, Option, type Path, Result, Schema, Semaphore } from "effect"
import { dirname } from "node:path"
import { checkBroker } from "./Broker.ts"
import type { ConfigEditor } from "./ConfigEditor.ts"
import { checkConfigText } from "./ConfigStore.ts"
import { pointsListFromText } from "./Import.ts"
import { checkPointsListByDevice, type PointsListDevice, profileNames } from "./PointsList.ts"
import { type Profile, resolveProfile } from "./Profile.ts"

/** How long a device test may take in all: connecting, finding a BACnet device, reading every point asked for. */
const READ_TEST_TIMEOUT = Duration.seconds(12)
/** How long a broker test may take: its dial (15 s at most) and the round trip (5 s). */
const BROKER_TEST_TIMEOUT = Duration.seconds(22)
/** The same device or broker is not tested again within this long, whatever the page sends. */
const SAME_TARGET_GAP_MS = 1_000
/** Modbus deadlines for a test: shorter than the gateway's, since a person waits for the answer. */
const MODBUS_CONNECT_TIMEOUT = Duration.seconds(3)
const MODBUS_REQUEST_TIMEOUT = Duration.seconds(2)

export interface SetupTools {
  readonly testBroker: (text: string) => Effect.Effect<BrokerTest, TestBusy | TestInvalid>
  readonly testRead: (
    text: string,
    device: number,
    points: ReadonlyArray<number> | undefined
  ) => Effect.Effect<ReadTest, TestBusy | TestInvalid>
  readonly importCheck: (text: string, name: string | undefined) => Effect.Effect<ImportCheck, ConfigUnreadableOf>
  readonly importApply: (
    text: string,
    name: string | undefined,
    etag: string
  ) => Effect.Effect<ImportApplied, ImportInvalid | Effect.Error<ReturnType<ConfigEditor["save"]>>>
}
type ConfigUnreadableOf = Effect.Error<ConfigEditor["file"]>

/** The config file as an object, every key kept: the page's candidate, or the file an import adds to. */
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeConfigObject = Schema.decodeUnknownOption(ConfigObject)

type JsonObject = Readonly<Record<string, unknown>>
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * One test at a time, and not the same target twice within `SAME_TARGET_GAP_MS`: the page has a button, and a
 * device on a building network should not see more than a person pressing it.
 */
export const makeTestGate = Effect.fnUntraced(function* () {
  const running = yield* Semaphore.make(1)
  const lastTested = new Map<string, number>()
  return <A, E, R>(target: string, test: Effect.Effect<A, E, R>): Effect.Effect<A, E | TestBusy, R> =>
    Effect.gen(function* () {
      const now = yield* monotonicMillis
      const last = lastTested.get(target)
      if (last !== undefined && now - last < SAME_TARGET_GAP_MS) {
        return yield* new TestBusy({ message: `${target} was tested a moment ago; try again in a second.` })
      }
      const done = yield* Semaphore.withPermitsIfAvailable(
        running,
        1
      )(
        Effect.gen(function* () {
          // Bounded: entries older than the gap say nothing any more.
          for (const [key, at] of lastTested) if (now - at >= SAME_TARGET_GAP_MS) lastTested.delete(key)
          lastTested.set(target, now)
          return yield* test
        })
      )
      if (Option.isNone(done)) {
        return yield* new TestBusy({ message: "Another test is running; try again when it is done." })
      }
      return done.value
    })
})

/** A failed read in the page's words: the driver's class and message. */
const failureOf = (error: DriverError): ReadFailure => ({ reason: error.reason, message: error.message })

/** A reading as the gateway would publish it: scaled, with the device's own value next to it when that differs. */
const pointResult = (point: Device["points"][number], reading: Reading): PointTest => {
  const value = typeof reading.value === "number" ? applyScaling(reading.value, point.scaling) : reading.value
  if (typeof value === "number" && !Number.isFinite(value)) {
    return {
      id: point.id,
      name: point.name,
      error: { reason: "invalid-response", message: `the device sent ${String(value)}, which is not a value` }
    }
  }
  return {
    id: point.id,
    name: point.name,
    value,
    ...(value === reading.value ? {} : { raw: reading.value }),
    ...(point.unit === undefined ? {} : { unit: point.unit })
  }
}

/**
 * Every point of `device` read once through `driverFor`: all together first, as the gateway reads them (a block
 * per run of registers), then each point the device did not answer for alone, to say why that one failed.
 */
const readPoints = Effect.fnUntraced(function* <P extends Device["points"][number]>(
  points: ReadonlyArray<P>,
  driverFor: (points: ReadonlyArray<P>) => Effect.Effect<Driver, DriverError>
) {
  const together = yield* Effect.result(Effect.flatMap(driverFor(points), (driver) => driver.readAll))
  // Unreachable: no point alone would do better, and each would wait for the same timeout.
  if (
    Result.isFailure(together) &&
    (together.failure.reason === "connection" ||
      together.failure.reason === "timeout" ||
      together.failure.reason === "configuration")
  ) {
    return { _tag: "unreachable" as const, error: together.failure }
  }
  const readings = Result.isSuccess(together) ? together.success : []
  const results = yield* Effect.forEach(points, (point) =>
    Effect.gen(function* () {
      const reading = readings.find((each) => each.pointId === point.id)
      if (reading !== undefined) return pointResult(point, reading)
      const alone = yield* Effect.result(Effect.flatMap(driverFor([point]), (driver) => driver.readAll))
      if (Result.isFailure(alone)) return { id: point.id, name: point.name, error: failureOf(alone.failure) }
      const single = alone.success.find((each) => each.pointId === point.id)
      return single === undefined
        ? {
            id: point.id,
            name: point.name,
            error: { reason: "protocol", message: "the device did not return this point" }
          }
        : pointResult(point, single)
    })
  )
  return { _tag: "read" as const, points: results }
})

/** A Modbus device read over a connection of the test's own. */
const testModbus = Effect.fnUntraced(function* (device: ModbusDevice, network: Pick<Network, "tcp"> | undefined) {
  const target = { host: device.host, port: device.port, openTimeout: MODBUS_CONNECT_TIMEOUT }
  const socket = yield* network ? network.tcp(target) : NodeSocket.makeNet(target)
  const client = yield* makeModbusClient(socket, {
    unitId: device.unitId,
    endpoint: endpointText(device),
    requestGap: Duration.millis(device.requestGapMs),
    requestTimeout: MODBUS_REQUEST_TIMEOUT
  })
  return yield* readPoints(device.points, (points) =>
    Effect.succeed(makeModbusDriverFromClient({ ...device, points }, client))
  )
}, Effect.scoped)

/**
 * A BACnet device read through a UDP socket of the test's own. While the gateway reads no BACnet device, the test
 * takes the configured port, where broadcast answers (I-Am) arrive; otherwise, or when the port is taken, a free
 * one, which hears only a device it asks at its address.
 */
const testBacnet = Effect.fnUntraced(function* (
  device: BacnetDevice,
  config: GatewayConfig,
  gatewayUsesPort: boolean,
  network: Pick<Network, "udp"> | undefined
) {
  const ownPort = { ...config.bacnet, port: 0 }
  const client = gatewayUsesPort
    ? yield* makeBacnetNetwork(ownPort, network)
    : yield* makeBacnetNetwork(config.bacnet, network).pipe(
        Effect.catchTag("BacnetSocketError", () => makeBacnetNetwork(ownPort, network))
      )
  const onOwnPort = gatewayUsesPort
  // A test reads; it does not subscribe to changes.
  const polled: BacnetDevice = { ...device, cov: false }
  const read = yield* readPoints(polled.points, (points) => makeBacnetDriverFromClient({ ...polled, points }, client))
  return { read, onOwnPort }
}, Effect.scoped)

/** Where a device is asked, in the page's words. */
const targetOf = (device: Device) => {
  switch (device.protocol) {
    case "modbus-tcp":
      return `${endpointText(device)}, unit ${device.unitId}`
    case "bacnet-ip":
      return `device ${device.deviceInstance}${device.address === undefined ? " (found by broadcast)" : ` at ${device.address}`}`
    case "simulator":
      return "simulated"
  }
}

/** The candidate's issues, about `devices[0]` and its chosen points, put back at the device and points they name. */
const issuesAt = (
  issues: ReadonlyArray<ConfigIssue>,
  deviceIndex: number,
  pointIndexes: ReadonlyArray<number>
): ReadonlyArray<ConfigIssue> =>
  issues.map((issue) => {
    const [first, second, third, fourth, ...rest] = issue.path
    if (first !== "devices" || second !== 0) return issue
    if (third === "points" && typeof fourth === "number") {
      return { ...issue, path: ["devices", deviceIndex, "points", pointIndexes[fourth] ?? fourth, ...rest] }
    }
    return {
      ...issue,
      path: [
        "devices",
        deviceIndex,
        ...(third === undefined ? [] : [third]),
        ...(fourth === undefined ? [] : [fourth]),
        ...rest
      ]
    }
  })

/** A config of one device of the candidate, with the points asked for, checked with the gateway's schema. */
export const candidateDevice = Effect.fnUntraced(function* (
  text: string,
  deviceIndex: number,
  asked: ReadonlyArray<number> | undefined
) {
  const raw = decodeConfigObject(text)
  if (Option.isNone(raw)) return yield* new TestInvalid({ message: "The config is not a JSON object.", issues: [] })
  const devices = raw.value["devices"]
  const device = Array.isArray(devices) ? devices[deviceIndex] : undefined
  if (!isObject(device)) {
    return yield* new TestInvalid({ message: `The config has no device at position ${deviceIndex + 1}.`, issues: [] })
  }
  const allPoints: ReadonlyArray<unknown> = Array.isArray(device["points"]) ? device["points"] : []
  const indexes = (asked ?? allPoints.map((_, index) => index))
    .filter((index) => index >= 0 && index < allPoints.length)
    .slice(0, MAX_TEST_POINTS)
  if (indexes.length === 0) {
    return yield* new TestInvalid({ message: "Add a point to read first.", issues: [] })
  }
  const single = { ...raw.value, devices: [{ ...device, points: indexes.map((index) => allPoints[index]) }] }
  const checked = yield* checkConfigText(JSON.stringify(single))
  if (Result.isFailure(checked)) {
    return yield* new TestInvalid({
      message: "Fix the fields marked first.",
      issues: issuesAt(checked.failure, deviceIndex, indexes)
    })
  }
  const parsed = checked.success.devices[0]
  if (parsed === undefined) return yield* Effect.die(new Error("a checked one-device config has no device"))
  return { config: checked.success, device: parsed }
})

/** A candidate's broker settings, checked with the gateway's schema; its devices are not what is tested. */
const candidateBroker = Effect.fnUntraced(function* (text: string) {
  const raw = decodeConfigObject(text)
  if (Option.isNone(raw)) return yield* new TestInvalid({ message: "The config is not a JSON object.", issues: [] })
  const checked = yield* checkConfigText(JSON.stringify({ ...raw.value, devices: [] }))
  if (Result.isFailure(checked)) {
    return yield* new TestInvalid({ message: "Fix the fields marked first.", issues: checked.failure })
  }
  return checked.success
})

/** What an upload adds: the page's check, and the config file with the devices that pass, if any do. */
interface UploadCheck {
  readonly check: ImportCheck
  readonly merged: { readonly text: string; readonly added: ReadonlyArray<PointsListDevice> } | undefined
}

/** An upload that adds nothing, for a mistake in the whole file. */
const empty = (format: ImportCheck["format"], notes: ReadonlyArray<string>, error: string): UploadCheck => ({
  check: { format, notes, error, devices: [], adds: { devices: 0, points: 0 } },
  merged: undefined
})

/** The address a points list's device has, in the page's words. */
const listedAddress = (device: PointsListDevice) =>
  device.protocol === "modbus-tcp"
    ? `${device.host}${device.port === undefined ? "" : `:${device.port}`}, unit ${device.unitId ?? 1}`
    : `device ${device.deviceInstance}${device.address === undefined ? "" : ` at ${device.address}`}`

export const makeSetupTools = Effect.fn("makeSetupTools")(function* (deps: {
  readonly editor: ConfigEditor
  /** The config file, for the profiles a points list names. */
  readonly configPath: string
  readonly running: () => GatewayConfig
  readonly network?: Network
}) {
  const gate = yield* makeTestGate()
  // Profiles are read from the gateway's library on disk.
  const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>()

  const testBroker = Effect.fn("Setup.testBroker")(function* (text: string) {
    const config = yield* candidateBroker(text)
    return yield* gate(
      `the broker at ${config.mqtt.url}`,
      checkBroker(config, deps.network).pipe(
        Effect.map((report): BrokerTest => ({
          ok: report.ok,
          broker: report.broker,
          protocolVersion: report.protocolVersion,
          ...(report.roundTripMs === undefined ? {} : { roundTripMs: report.roundTripMs }),
          warnings: report.warnings
        })),
        Effect.catchTags({
          BrokerCommandError: (error) => Effect.succeed(brokerFailed(config, error.message)),
          MqttSettingsError: (error) => Effect.succeed(brokerFailed(config, error.message))
        }),
        Effect.timeoutOrElse({
          duration: BROKER_TEST_TIMEOUT,
          orElse: () => Effect.succeed(brokerFailed(config, `no answer within ${Duration.format(BROKER_TEST_TIMEOUT)}`))
        }),
        Effect.tap((result) =>
          Effect.logInfo("broker tested from the status page").pipe(
            Effect.annotateLogs({
              broker: result.broker,
              ok: result.ok,
              ...(result.error === undefined ? {} : { error: result.error })
            })
          )
        )
      )
    )
  })

  const testRead = Effect.fn("Setup.testRead")(function* (
    text: string,
    deviceIndex: number,
    asked: ReadonlyArray<number> | undefined
  ) {
    const { config, device } = yield* candidateDevice(text, deviceIndex, asked)
    const target = targetOf(device)
    const started = yield* monotonicMillis
    const running = deps.running()
    const outcome = yield* gate(
      target,
      Effect.gen(function* () {
        switch (device.protocol) {
          case "modbus-tcp": {
            const read = yield* testModbus(device, deps.network)
            // The gateway holds a connection to this endpoint: a refusal may be the device's limit on clients.
            const shared = running.devices.some(
              (each) => each.protocol === "modbus-tcp" && endpointOf(each) === endpointOf(device)
            )
            const note =
              read._tag === "unreachable" && read.error.reason === "connection" && shared
                ? `The gateway is connected to ${endpointText(device)} already, and the device did not take this test's second connection: many Modbus devices allow one or two clients. The gateway's own connection was not touched. Save the device and the gateway reads it over the connection it has.`
                : undefined
            return { read, note }
          }
          case "bacnet-ip": {
            const gatewayUsesPort = running.devices.some((each) => each.protocol === "bacnet-ip")
            const { read, onOwnPort } = yield* testBacnet(device, config, gatewayUsesPort, deps.network).pipe(
              Effect.catchTag("BacnetSocketError", (error) =>
                Effect.succeed({
                  read: {
                    _tag: "unreachable" as const,
                    error: { reason: "connection", message: `no UDP port for the test: ${error.message}` }
                  },
                  onOwnPort: true
                })
              )
            )
            const note =
              read._tag === "unreachable" &&
              read.error.reason === "timeout" &&
              device.address === undefined &&
              onOwnPort
                ? `The gateway holds UDP port ${config.bacnet.port}, so this test listens on another port and does not hear broadcast answers. Give the device's address (ip or ip:port) to test it, or save it and watch the Status tab.`
                : undefined
            return { read, note }
          }
          case "simulator":
            return {
              read: { _tag: "unreachable" as const, error: undefinedSimulator(device.id) },
              note: undefined
            }
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: READ_TEST_TIMEOUT,
          orElse: () =>
            Effect.succeed({
              read: {
                _tag: "unreachable" as const,
                error: { reason: "timeout", message: `no answer within ${Duration.format(READ_TEST_TIMEOUT)}` }
              },
              note: undefined
            })
        })
      )
    )
    const finished = yield* monotonicMillis
    const { read, note } = outcome
    const points: ReadonlyArray<PointTest> = read._tag === "read" ? read.points : []
    const result: ReadTest = {
      device: device.id,
      protocol: device.protocol,
      target,
      ok: read._tag === "read" && points.every((point) => point.error === undefined),
      ...(read._tag === "unreachable" ? { error: read.error } : {}),
      ...(note === undefined ? {} : { note }),
      points,
      durationMs: Math.max(0, finished - started)
    }
    yield* Effect.logInfo("device tested from the status page").pipe(
      Effect.annotateLogs({
        device: device.id,
        target,
        ok: result.ok,
        points: points.length,
        ...(result.error === undefined ? {} : { error: result.error.message })
      })
    )
    return result
  })

  /** The profiles a points list names, from the gateway's library; a profile file is for the command line. */
  const profilesOf = Effect.fnUntraced(function* (list: string) {
    const profiles = new Map<string, Profile>()
    for (const name of profileNames(list)) {
      if (name.toLowerCase().endsWith(".json")) {
        return Result.fail(
          `profile "${name}" is a file; on this page a points list names profiles from the library only (ot-gateway profiles list). Import it with ot-gateway import instead.`
        )
      }
      const profile = yield* Effect.result(resolveProfile(name, { relativeTo: dirname(deps.configPath) }))
      if (Result.isFailure(profile)) return Result.fail(profile.failure.message)
      profiles.set(name, profile.success)
    }
    return Result.succeed(profiles)
  })

  /** What an uploaded file adds to the config file as it is now, device by device, and the config with them. */
  const checkUpload = Effect.fnUntraced(function* (text: string, name: string | undefined) {
    const file = yield* deps.editor.file
    const source = name ?? "the file"
    const read = yield* Effect.result(pointsListFromText(text, source))
    if (Result.isFailure(read)) return empty("ede", [], read.failure.message)
    const { list, format, notes } = read.success
    const raw = decodeConfigObject(file.text)
    if (Option.isNone(raw)) {
      return empty(format, notes, "The config file is not a JSON object right now; fix it first.")
    }
    const rawDevices: ReadonlyArray<unknown> = Array.isArray(raw.value["devices"]) ? raw.value["devices"] : []
    const existing = rawDevices.flatMap((device) =>
      isObject(device) && typeof device["id"] === "string" ? [device["id"]] : []
    )
    const profiles = yield* profilesOf(list)
    if (Result.isFailure(profiles)) return empty(format, notes, profiles.failure)
    const checked = yield* Effect.result(checkPointsListByDevice(list, existing, profiles.success))
    if (Result.isFailure(checked)) return empty(format, notes, checked.failure.message)
    // Each device that passed the list's rules also passes the gateway's schema, or is marked with what it breaks.
    const schemaErrors = new Map<number, string>()
    let merged: { readonly text: string; readonly added: ReadonlyArray<PointsListDevice> } | undefined
    for (let attempt = 0; attempt <= checked.success.length; attempt++) {
      const passing = checked.success.flatMap((device, index) =>
        Result.isSuccess(device.result) && !schemaErrors.has(index) ? [{ index, device: device.result.success }] : []
      )
      if (passing.length === 0) break
      const added = passing.map((each) => each.device)
      const candidate = `${JSON.stringify({ ...raw.value, devices: [...rawDevices, ...added] }, null, 2)}\n`
      const parsed = yield* checkConfigText(candidate)
      if (Result.isSuccess(parsed)) {
        merged = { text: candidate, added }
        break
      }
      const before = schemaErrors.size
      for (const issue of parsed.failure) {
        const [first, position, ...rest] = issue.path
        if (first !== "devices" || typeof position !== "number" || position < rawDevices.length) continue
        const owner = passing[position - rawDevices.length]
        if (owner === undefined || schemaErrors.has(owner.index)) continue
        schemaErrors.set(owner.index, `${rest.length === 0 ? "" : `${rest.join(".")}: `}${issue.message}`)
      }
      // Nothing to blame on the new devices: the file has problems of its own.
      if (schemaErrors.size === before) {
        return empty(
          format,
          notes,
          `The config file has problems of its own, so nothing can be added: ${parsed.failure
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`
        )
      }
    }
    const devices = checked.success.map((device, index): ImportDevice => {
      if (Result.isFailure(device.result)) {
        return {
          name: device.name,
          id: "",
          lines: device.lines,
          points: device.lines.length,
          error: device.result.failure.message
        }
      }
      const entry = device.result.success
      const schemaError = schemaErrors.get(index)
      return {
        name: device.name,
        id: entry.id,
        protocol: entry.protocol,
        address: listedAddress(entry),
        lines: device.lines,
        points: entry.points.length,
        ...(schemaError === undefined ? {} : { error: schemaError })
      }
    })
    const adds = merged?.added ?? []
    const result: UploadCheck = {
      check: {
        format,
        notes,
        devices,
        adds: { devices: adds.length, points: adds.reduce((total, device) => total + device.points.length, 0) }
      },
      merged
    }
    return result
  })

  const importCheck = Effect.fn("Setup.importCheck")(function* (text: string, name: string | undefined) {
    return (yield* checkUpload(text, name)).check
  }, Effect.provideContext(files))

  const importApply = Effect.fn("Setup.importApply")(function* (text: string, name: string | undefined, etag: string) {
    const { check, merged } = yield* checkUpload(text, name)
    if (check.error !== undefined) return yield* new ImportInvalid({ message: check.error })
    if (merged === undefined) {
      return yield* new ImportInvalid({ message: "No device in the file can be added; the check says why." })
    }
    const saved = yield* deps.editor.save(merged.text, etag)
    yield* Effect.logInfo("points list added from the status page").pipe(
      Effect.annotateLogs({ file: name ?? "", devices: check.adds.devices, points: check.adds.points })
    )
    return {
      etag: saved.etag,
      applied: saved.applied,
      devices: check.adds.devices,
      points: check.adds.points,
      skipped: check.devices.length - check.adds.devices
    } satisfies ImportApplied
  }, Effect.provideContext(files))

  return { testBroker, testRead, importCheck, importApply } satisfies SetupTools
})

const brokerFailed = (config: GatewayConfig, error: string): BrokerTest => ({
  ok: false,
  broker: config.mqtt.url,
  warnings: [],
  error
})

const undefinedSimulator = (id: string): ReadFailure => ({
  reason: "not-implemented",
  message: `${id} is simulated: it has nothing to test, the Status tab shows its values`
})
