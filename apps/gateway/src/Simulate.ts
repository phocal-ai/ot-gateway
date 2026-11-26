/**
 * `ot-gateway simulate bacnet`: one simulated BACnet/IP device on the LAN, to try discovery, reads and writes from
 * another machine (a gateway on a laptop, the device on a Pi) without a building. It is a room with three objects:
 *
 * - `analog-input 1` "Room temperature" (°C, read-only), which the heating moves towards the setpoint
 * - `analog-value 1` "Temperature setpoint" (°C, writable), 21 °C to start with
 * - `binary-input 1` "Heating" (read-only), on while the room is more than `HYSTERESIS` below the setpoint
 *
 * so a written setpoint shows within seconds: the heating switches and the temperature follows. It answers Who-Is,
 * ReadProperty, ReadPropertyMultiple, SubscribeCOV and WriteProperty (Simulator.ts) on UDP `port` of `listen`,
 * every interface by default, so a broadcast Who-Is reaches it (on Linux a socket bound to one address does not
 * receive broadcasts). Unlike the bench's devices it is meant for the LAN, and it prints each write it takes.
 */
import { lanInterfaces } from "./Init.ts"
import { makeSimulatedDevice, ObjectType, PropertyId, serveSimulatedDevice, setPresentValue } from "@ot-gateway/bacnet"
import type { SimulatedDevice } from "@ot-gateway/bacnet"
import { describeDatagramSocketError, monotonicMillis, type Network } from "@ot-gateway/core"
import * as NodeDatagramSocket from "@effect/platform-node/NodeDatagramSocket"
import { Console, Effect, Schedule, Schema } from "effect"
import { networkInterfaces } from "node:os"

/** The room's temperature and whether its heating runs. */
export interface RoomState {
  /** °C. */
  readonly temperature: number
  readonly heating: boolean
}

/** How far below the setpoint the heating switches on, and above it off, in K. */
export const HYSTERESIS = 0.3
/** How fast the heating warms the room, in K per second: a written setpoint 3 K up shows in about a minute. */
export const HEATING_RATE = 0.05
/** How fast the room cools with the heating off, in K per second, down to `COLDEST`. */
export const COOLING_RATE = 0.02
/** Where the room stops cooling, in °C: the heating is off, not the building. */
export const COLDEST = 12
/** Where it stops warming, in °C, whatever the setpoint. */
export const WARMEST = 35

/** Where the room starts: a little below the setpoint, so the heating is on and the temperature climbs. */
export const START: RoomState = { temperature: 19.5, heating: true }
export const START_SETPOINT = 21

/**
 * The room `seconds` later at `setpoint`. The heating switches with hysteresis, as a thermostat does, so it does not
 * flicker around the setpoint; the temperature rises or falls at a fixed rate within `COLDEST` and `WARMEST`.
 */
export const stepRoom = (state: RoomState, setpoint: number, seconds: number): RoomState => {
  const heating =
    state.temperature < setpoint - HYSTERESIS ? true : state.temperature > setpoint + HYSTERESIS ? false : state.heating
  const moved = heating
    ? Math.min(WARMEST, state.temperature + HEATING_RATE * seconds)
    : Math.max(COLDEST, state.temperature - COOLING_RATE * seconds)
  return { temperature: Math.round(moved * 100) / 100, heating }
}

/** The three objects, as `discover` finds them. */
export const ROOM_OBJECTS = {
  temperature: { objectType: "analog-input", instance: 1, name: "Room temperature" },
  setpoint: { objectType: "analog-value", instance: 1, name: "Temperature setpoint" },
  heating: { objectType: "binary-input", instance: 1, name: "Heating" }
} as const

/** BACnetEngineeringUnits degrees-Celsius. */
const DEGREES_CELSIUS = 62

/** The simulated room device, at `START`. */
export const makeRoomDevice = (instance: number): SimulatedDevice =>
  makeSimulatedDevice({
    instance,
    name: "Demo room",
    objects: [
      {
        ...ROOM_OBJECTS.temperature,
        presentValue: { type: "real", value: START.temperature },
        units: DEGREES_CELSIUS
      },
      { ...ROOM_OBJECTS.setpoint, presentValue: { type: "real", value: START_SETPOINT }, units: DEGREES_CELSIUS },
      { ...ROOM_OBJECTS.heating, presentValue: { type: "enumerated", value: START.heating ? 1 : 0 } }
    ]
  })

/** The setpoint the device holds now: what was last written, or the start. */
export const roomSetpoint = (device: SimulatedDevice): number => {
  const key = `${ObjectType[ROOM_OBJECTS.setpoint.objectType]}:${ROOM_OBJECTS.setpoint.instance}`
  const [value] = device.objects.get(key)?.get(PropertyId["present-value"]) ?? []
  return value?.type === "real" ? value.value : START_SETPOINT
}

/** Put `state` into the device's temperature and heating objects (subscribers hear of each change). */
export const showRoom = (device: SimulatedDevice, state: RoomState) => {
  setPresentValue(device, ROOM_OBJECTS.temperature, { type: "real", value: state.temperature })
  setPresentValue(device, ROOM_OBJECTS.heating, { type: "enumerated", value: state.heating ? 1 : 0 })
}

/** A line for each write the device took since the last call, which it then forgets (it runs for days). */
export const takeWrites = (device: SimulatedDevice): ReadonlyArray<string> =>
  device.writes.splice(0).map((write) => {
    const name =
      Object.values(ROOM_OBJECTS).find(
        (object) =>
          ObjectType[object.objectType] === write.object.objectType && object.instance === write.object.instance
      )?.name ?? `object ${write.object.objectType}:${write.object.instance}`
    const value = write.value.type === "real" ? `${Math.round(write.value.value * 100) / 100} °C` : write.value.type
    return `write: ${name} set to ${value}${write.priority === undefined ? "" : ` (priority ${write.priority})`}`
  })

/** The simulated device could not start: its port is taken, or the address is not this machine's. */
export class SimulateError extends Schema.TaggedError<SimulateError>()("SimulateError", {
  message: Schema.String
}) {}

export interface SimulateOptions {
  /** The device instance (0 to 4,194,302). */
  readonly instance: number
  /** The address to bind; `0.0.0.0` (every interface) to be found by broadcast. */
  readonly listen: string
  /** The UDP port; 47808 to be found by a broadcast Who-Is. */
  readonly port: number
}

/** What the device prints on start: what it is, where, and how to find it from another machine. */
export const startBanner = (
  options: SimulateOptions,
  lans: ReadonlyArray<{ readonly name: string; readonly address: string }>
): ReadonlyArray<string> => {
  const portSuffix = options.port === 47_808 ? "" : `:${options.port}`
  const [first] = lans
  const here = options.listen === "0.0.0.0" ? first?.address : options.listen
  return [
    `Simulated BACnet/IP device ${options.instance} "Demo room" on UDP ${options.listen}:${options.port}, 3 objects:`,
    `  analog-input 1   Room temperature       °C, moves towards the setpoint`,
    `  analog-value 1   Temperature setpoint   °C, writable, ${START_SETPOINT} to start with`,
    `  binary-input 1   Heating                on while the room is below the setpoint`,
    ...(options.listen === "0.0.0.0" && lans.length > 0
      ? [`This machine on the LAN: ${lans.map((lan) => `${lan.address} (${lan.name})`).join(", ")}`]
      : []),
    `Find it from another machine on this network:`,
    options.port === 47_808
      ? `  npx ot-gateway discover${here === undefined ? "" : `     (or discover --address ${here} where broadcasts do not arrive)`}`
      : `  npx ot-gateway discover --address ${here ?? "<this machine's address>"}${portSuffix}     (a broadcast Who-Is goes to 47808 only)`,
    `Writes are printed here. Stop with Ctrl+C.`
  ]
}

/** How often the room is updated. */
const TICK = "1 second"
/** The longest step taken at once, so a Pi that was suspended does not jump the room to its limits. */
const MAX_STEP_SECONDS = 10

/**
 * Run the simulated room until interrupted. `network` stands in for Node's UDP in tests.
 */
export const simulateBacnet = Effect.fn("simulateBacnet")(function* (
  options: SimulateOptions,
  network?: Pick<Network, "udp">,
  lans: () => ReadonlyArray<{ readonly name: string; readonly address: string }> = () =>
    lanInterfaces(networkInterfaces())
) {
  const device = makeRoomDevice(options.instance)
  const socket = yield* network === undefined
    ? NodeDatagramSocket.make({ bind: { address: options.listen, port: options.port } })
    : network.udp({ address: options.listen, port: options.port })
  yield* serveSimulatedDevice(socket, device).pipe(
    Effect.catchTag("DatagramSocketError", (error) =>
      Effect.fail(
        new SimulateError({
          message:
            error.reason._tag === "DatagramSocketOpenError" && error.reason.kind === "AddressInUse"
              ? `UDP port ${options.port} is in use, probably by an ot-gateway, a demo or a BACnet tool on this machine: stop it, or run on another port with --port ${options.port + 1} (and discover it with --address <this machine>:${options.port + 1})`
              : `could not listen on UDP ${options.listen}:${options.port}: ${describeDatagramSocketError(error)}`
        })
      )
    )
  )
  for (const line of startBanner(options, lans())) yield* Console.log(line)

  let state = START
  let last = yield* monotonicMillis
  yield* Effect.gen(function* () {
    const now = yield* monotonicMillis
    const seconds = Math.min(MAX_STEP_SECONDS, Math.max(0, (now - last) / 1000))
    last = now
    for (const line of takeWrites(device)) yield* Console.log(line)
    const next = stepRoom(state, roomSetpoint(device), seconds)
    if (next.heating !== state.heating) {
      yield* Console.log(`heating ${next.heating ? "on" : "off"} at ${next.temperature} °C`)
    }
    state = next
    showRoom(device, state)
  }).pipe(Effect.repeat(Schedule.spaced(TICK)))
})
