/**
 * What `discover` in a terminal saves: the devices the operator picked, merged into the config file. A device the
 * config has already (the same id, as discovery drafts a configured BACnet device under its config id) gets the
 * new points after its own; any other is added after the config's devices. Every other key of the file stays as
 * it was, and the result is decoded with the gateway's own schema before the save, which refuses it when the file
 * changed in between (the status page saved it, or an editor).
 */
import { parseConfig } from "@ot-gateway/core"
import { Effect, Schema } from "effect"
import { etagOf, makeConfigStore } from "./ConfigStore.ts"
import { DiscoverError } from "./Discover.ts"
import type { InitDevice } from "./Init.ts"

/** The config file as it is, every key kept, to merge devices into. */
const ConfigObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** How the picked devices went into the config: added as new devices, or points added to one it has. */
export interface Merged {
  readonly text: string
  readonly added: ReadonlyArray<string>
  readonly extended: ReadonlyArray<string>
}

/**
 * Whether `existing` in the file is the device `picked` drafts more points of: the same id and the same device, by
 * protocol and its instance (BACnet) or host and unit id (Modbus). Two devices that only share an id are not.
 */
const sameDevice = (existing: Readonly<Record<string, unknown>>, picked: InitDevice) => {
  if (existing["id"] !== picked.id || existing["protocol"] !== picked.protocol) return false
  if (picked.protocol === "bacnet-ip") return existing["deviceInstance"] === picked.deviceInstance
  if (picked.protocol === "modbus-tcp") {
    return existing["host"] === picked.host && (existing["unitId"] ?? 1) === (picked.unitId ?? 1)
  }
  return false
}

/** `wanted`, or `wanted-2`, `wanted-3`…: the first id no device in `taken` has. */
const freeId = (taken: ReadonlySet<unknown>, wanted: string) => {
  let id = wanted
  for (let n = 2; taken.has(id); n++) id = `${wanted.slice(0, 60)}-${n}`
  return id
}

/** A broadcast the file sets that reaches the devices: one it names, other than the limited broadcast. */
const setsNetwork = (bacnet: Readonly<Record<string, unknown>> | undefined) =>
  typeof bacnet?.["broadcastAddress"] === "string" && bacnet["broadcastAddress"] !== "255.255.255.255"

/**
 * The config's `raw` object with `picked` merged in, as text formatted as `init` writes it. `broadcastAddress`,
 * when given, becomes `bacnet.broadcastAddress` unless the file names a subnet's: a device found by broadcast needs
 * the network it was found on, and 255.255.255.255 does not cross most networks' settings.
 */
export const mergeDevices = (
  raw: Readonly<Record<string, unknown>>,
  picked: ReadonlyArray<InitDevice>,
  broadcastAddress?: string
): Merged => {
  const devices: Array<unknown> = Array.isArray(raw["devices"]) ? [...raw["devices"]] : []
  const added: Array<string> = []
  const extended: Array<string> = []
  for (const device of picked) {
    const at = devices.findIndex((existing) => isRecord(existing) && sameDevice(existing, device))
    const existing = at === -1 ? undefined : devices[at]
    if (isRecord(existing) && Array.isArray(existing["points"])) {
      devices[at] = { ...existing, points: [...existing["points"], ...device.points] }
      extended.push(device.id)
      continue
    }
    const taken = new Set(devices.map((other) => (isRecord(other) ? other["id"] : undefined)))
    const id = freeId(taken, device.id)
    devices.push({ ...device, id })
    added.push(id)
  }
  const bacnet = isRecord(raw["bacnet"]) ? raw["bacnet"] : undefined
  const withNetwork =
    broadcastAddress === undefined || setsNetwork(bacnet) ? raw : { ...raw, bacnet: { ...bacnet, broadcastAddress } }
  return { text: `${JSON.stringify({ ...withNetwork, devices }, null, 2)}\n`, added, extended }
}

/**
 * `picked` merged into `fileText`, the config file at `path` as discover read it, and decoded with the gateway's own
 * schema: what a save would write, and the file as it was, to show the difference before asking. Fails when the result would not decode.
 */
export const mergeDiscovered = Effect.fn("mergeDiscovered")(function* (
  path: string,
  fileText: string,
  picked: ReadonlyArray<InitDevice>,
  broadcastAddress?: string
) {
  const raw = yield* Schema.decodeUnknownEffect(ConfigObject)(fileText).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(new DiscoverError({ message: `${path} is not a JSON object; nothing was saved` }))
    )
  )
  const merged = mergeDevices(raw, picked, broadcastAddress)
  // The file as it was, decoded the same way, so a diff of the two shows only what the merge changed.
  const before = yield* parseConfig(fileText).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(new DiscoverError({ message: `${path} is not a valid config; nothing was saved:\n${error.message}` }))
    )
  )
  const config = yield* parseConfig(merged.text).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.fail(
        new DiscoverError({
          message: `the devices would make ${path} invalid, so nothing was saved:\n${error.message}`
        })
      )
    )
  )
  return { ...merged, before, config }
})

/**
 * Writes `merged` over the config at `path`, unless the file is no longer `fileText`: a change made meanwhile (the
 * status page, an editor) is refused rather than overwritten.
 */
export const writeMerged = Effect.fn("writeMerged")(function* (path: string, fileText: string, merged: Merged) {
  const store = yield* makeConfigStore(path)
  yield* store.save(merged.text, etagOf(fileText)).pipe(
    Effect.catchTags({
      ConfigConflict: () =>
        Effect.fail(
          new DiscoverError({
            message: `${path} changed while discover ran (saved from the status page, or edited): nothing was saved; discover again`
          })
        ),
      ConfigInvalid: (error) => Effect.fail(new DiscoverError({ message: error.message })),
      ConfigUnreadable: (error) => Effect.fail(new DiscoverError({ message: error.message })),
      ConfigWriteFailed: (error) =>
        Effect.fail(new DiscoverError({ message: `${error.message}; ${path} is as it was` }))
    })
  )
})

/** Saves `picked` into the config at `path`: `mergeDiscovered`, then `writeMerged`, nothing written on a failure. */
export const saveDiscovered = Effect.fn("saveDiscovered")(function* (
  path: string,
  fileText: string,
  picked: ReadonlyArray<InitDevice>,
  broadcastAddress?: string
) {
  const merged = yield* mergeDiscovered(path, fileText, picked, broadcastAddress)
  yield* writeMerged(path, fileText, merged)
  return merged
})
