/**
 * Setting devices up from the status page: test the broker and a device with settings that are not saved yet, and
 * add the devices of a points list or EDE file.
 *
 * The tests take the page's candidate config as text, the same text a save would send, so the gateway checks it
 * with the one schema (`parseConfig`) and the page needs no second copy of the device model. They only read: a
 * broker test connects with a client id of its own and sends one message to itself; a device test reads the chosen
 * points once over a connection of its own. One test runs at a time, each within a short deadline, and the same
 * device or broker is not asked again within a moment, so a page cannot hammer a device. The broker password comes
 * from the variable the config names, as for the gateway, never from the request.
 *
 * BACnet discovery (`/api/discover/devices`, then `/api/discover/objects` for the device picked) sends Who-Is and
 * reads a device's object list, names, units and present values, as `ot-gateway discover` does, from a UDP socket of
 * its own, under the same one-at-a-time rule and a deadline, and bounded in devices and objects.
 *
 * Every one of these is a POST, so it passes the edit guard (same origin, `X-OT-Gateway: 1`, loopback or the token).
 */
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import {
  ConfigApplyFailed,
  ConfigChange,
  ConfigConflict,
  ConfigInvalid,
  ConfigIssue,
  ConfigUnreadable,
  ConfigWriteFailed,
  EditingDisabled
} from "./Editor.ts"

/** The largest points list or EDE file the page may send: a building's list is a few hundred KiB at most. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024

/** The most points one device test reads. */
export const MAX_TEST_POINTS = 25

/** A candidate config's text, at most as large as a points list: the request body is bounded too. */
const CandidateText = Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_IMPORT_BYTES)))

/** Why a device or a point could not be read: the driver's failure class and its words. */
export const ReadFailure = Schema.Struct({
  /** `connection`, `timeout`, `protocol`, `invalid-response`, `configuration`, `not-implemented` (DriverError). */
  reason: Schema.String,
  message: Schema.String
})
export type ReadFailure = typeof ReadFailure.Type

/** One point's test read: the value as the gateway would publish it (scaled), with its unit, or why not. */
export const PointTest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean])),
  /** What the device sent, before scaling, when scaling changed it. */
  raw: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean])),
  unit: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(ReadFailure)
})
export type PointTest = typeof PointTest.Type

/** A device's test read. `ok` when it answered and every point asked for was read. */
export const ReadTest = Schema.Struct({
  device: Schema.String,
  protocol: Schema.Literals(["modbus-tcp", "bacnet-ip", "simulator"]),
  /** Where it was asked: `192.168.1.30:502, unit 1`, `device 2001 at 192.168.1.40`. */
  target: Schema.String,
  ok: Schema.Boolean,
  /** The device could not be reached at all: no point was read. */
  error: Schema.optionalKey(ReadFailure),
  /**
   * What to know about this result, in a sentence: the device refused this test's connection while the gateway
   * holds one to it (many Modbus devices take one or two clients; the gateway's was not touched), or the test could
   * not hear a BACnet broadcast answer.
   */
  note: Schema.optionalKey(Schema.String),
  points: Schema.Array(PointTest),
  durationMs: Schema.Number
})
export type ReadTest = typeof ReadTest.Type

/** A broker test: connected (with what the broker allows), and whether a message came back, or why not. */
export const BrokerTest = Schema.Struct({
  ok: Schema.Boolean,
  broker: Schema.String,
  protocolVersion: Schema.optionalKey(Schema.String),
  roundTripMs: Schema.optionalKey(Schema.Number),
  warnings: Schema.Array(Schema.String),
  /** Why it did not connect, or did not take the message. */
  error: Schema.optionalKey(Schema.String)
})
export type BrokerTest = typeof BrokerTest.Type

/** One device of an uploaded points list: what it would add, or what is wrong with it. */
export const ImportDevice = Schema.Struct({
  /** As the list names it. */
  name: Schema.String,
  /** Its id in the config (a slug of the name); empty when the name has no letters or digits. */
  id: Schema.String,
  protocol: Schema.optionalKey(Schema.Literals(["modbus-tcp", "bacnet-ip"])),
  /** Where it is: `host:port, unit n` or `device n`. */
  address: Schema.optionalKey(Schema.String),
  /** The lines of the file its rows are on (of the translated list, for an EDE file). */
  lines: Schema.Array(Schema.Number),
  points: Schema.Number,
  /** What keeps it out, naming the line; it is not added. */
  error: Schema.optionalKey(Schema.String)
})
export type ImportDevice = typeof ImportDevice.Type

/** What an uploaded file would add, device by device, as `ot-gateway import --dry-run` checks it. */
export const ImportCheck = Schema.Struct({
  format: Schema.Literals(["points-list", "ede"]),
  /** What was translated or ignored (an EDE file's skipped objects, unknown columns). */
  notes: Schema.Array(Schema.String),
  /** A mistake in the file as a whole (its header, a quote never closed): nothing can be added. */
  error: Schema.optionalKey(Schema.String),
  devices: Schema.Array(ImportDevice),
  /** What "Add" adds: the devices without an error and their points. */
  adds: Schema.Struct({ devices: Schema.Number, points: Schema.Number })
})
export type ImportCheck = typeof ImportCheck.Type

/** Added and applied: the config file's new ETag, what changed, and how many devices were left out. */
export const ImportApplied = Schema.Struct({
  etag: Schema.String,
  applied: ConfigChange,
  devices: Schema.Number,
  points: Schema.Number,
  skipped: Schema.Number
})
export type ImportApplied = typeof ImportApplied.Type

/** The most devices a discovery lists for the page. */
export const MAX_DISCOVERED_DEVICES = 200
/** The most objects a discovery reads from one device for the page: a draft beyond that is a points list's job. */
export const MAX_DISCOVERED_OBJECTS = 300
/** How long a discovery listens for answers to Who-Is, in seconds: 3 by default, at most 10. */
export const DISCOVER_SECONDS = { default: 3, max: 10 } as const

/** A BACnet device that answered Who-Is. */
export const FoundBacnetDevice = Schema.Struct({
  instance: Schema.Number,
  /**
   * Where it answered from, as the config's `address` takes it (`ip` or `ip:port`). Left out for a device behind a
   * router, and for one that more than one address answered for: then the instance does not say which host it is.
   */
  address: Schema.optionalKey(Schema.String),
  /** Its object-name, when it gave one in time; printable characters only, at most 120. */
  name: Schema.optionalKey(Schema.String),
  /** Every other address that answered for the same instance: two devices may share it. */
  conflicts: Schema.Array(Schema.String),
  /** The id of the device in the running config with this instance, if there is one. */
  configured: Schema.optionalKey(Schema.String)
})
export type FoundBacnetDevice = typeof FoundBacnetDevice.Type

/** What a Who-Is found: the devices, whether more answered than are listed, and what to know. */
export const DiscoveredDevices = Schema.Struct({
  /** Where Who-Is went: the broadcast address, or the one address asked. */
  asked: Schema.String,
  devices: Schema.Array(FoundBacnetDevice),
  /** More devices answered than `MAX_DISCOVERED_DEVICES`. */
  more: Schema.Boolean,
  /** Why none answered, or why a broadcast may not have been heard (another program holds the BACnet port). */
  note: Schema.optionalKey(Schema.String),
  durationMs: Schema.Number
})
export type DiscoveredDevices = typeof DiscoveredDevices.Type

/** One object of a device, as a point to add: the id and name the config would get, its unit and its value now. */
export const DiscoveredObject = Schema.Struct({
  objectType: Schema.String,
  instance: Schema.Number,
  /** Its object-name, printable characters only; `<type> <instance>` when the device gave none. */
  name: Schema.String,
  /** A point id from the name, unique within the device. */
  id: Schema.String,
  /** QUDT, for an analog object whose units the gateway knows. */
  unit: Schema.optionalKey(Schema.String),
  /** Its present value, when it was read. */
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Boolean])),
  /** The running config's device for this instance has a point for it already. */
  configured: Schema.Boolean
})
export type DiscoveredObject = typeof DiscoveredObject.Type

/** One device's objects, read for the page to pick points from. */
export const DiscoveredObjects = Schema.Struct({
  instance: Schema.Number,
  /** As the config's `address` takes it. */
  address: Schema.String,
  name: Schema.String,
  /** A device id from its name, not taken in the running config. */
  id: Schema.String,
  /** How many objects the device lists; only the first `MAX_DISCOVERED_OBJECTS` are read. */
  listed: Schema.Number,
  objects: Schema.Array(DiscoveredObject),
  durationMs: Schema.Number
})
export type DiscoveredObjects = typeof DiscoveredObjects.Type

/** Discovery could not run, or the device did not answer: no UDP port, no answer within the deadline. */
export class DiscoveryFailed extends Schema.TaggedError<DiscoveryFailed>()(
  "DiscoveryFailed",
  { message: Schema.String },
  { httpApiStatus: 502 }
) {}

/** Another test is running, or this one asked the same device or broker a moment ago. */
export class TestBusy extends Schema.TaggedError<TestBusy>()(
  "TestBusy",
  { message: Schema.String },
  { httpApiStatus: 429 }
) {}

/** The test cannot run with this candidate (no such device, a config that does not parse there). */
export class TestInvalid extends Schema.TaggedError<TestInvalid>()(
  "TestInvalid",
  {
    message: Schema.String,
    issues: Schema.Array(ConfigIssue)
  },
  { httpApiStatus: 400 }
) {}

/** The uploaded file adds nothing: a mistake in the whole file, or no device without an error. */
export class ImportInvalid extends Schema.TaggedError<ImportInvalid>()(
  "ImportInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

const ImportUpload = Schema.Struct({
  text: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_IMPORT_BYTES))),
  /** The file's name, for the notes. */
  name: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(255))))
})

export class SetupGroup extends HttpApiGroup.make("setup")
  .add(
    HttpApiEndpoint.post("testBroker", "/api/test/broker", {
      payload: Schema.Struct({ text: CandidateText }),
      success: BrokerTest,
      error: [EditingDisabled, TestBusy, TestInvalid]
    })
  )
  .add(
    HttpApiEndpoint.post("testRead", "/api/test/read", {
      payload: Schema.Struct({
        text: CandidateText,
        /** The device's index in the candidate's `devices`: a device being typed may not have a valid id yet. */
        device: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
        /** Indexes of its points to read; all of them (up to MAX_TEST_POINTS) when left out. */
        points: Schema.optionalKey(Schema.Array(Schema.Int))
      }),
      success: ReadTest,
      error: [EditingDisabled, TestBusy, TestInvalid]
    })
  )
  .add(
    HttpApiEndpoint.post("discoverDevices", "/api/discover/devices", {
      payload: Schema.Struct({
        /** Ask this `ip` or `ip:port` only, instead of broadcasting: a device on another subnet or port. */
        address: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))),
        seconds: Schema.optionalKey(
          Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: DISCOVER_SECONDS.max })))
        )
      }),
      success: DiscoveredDevices,
      error: [EditingDisabled, TestBusy, TestInvalid, DiscoveryFailed]
    })
  )
  .add(
    HttpApiEndpoint.post("discoverObjects", "/api/discover/objects", {
      payload: Schema.Struct({
        instance: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_194_302 }))),
        /** Where it answered: `ip` or `ip:port`, as the device list gave it. */
        address: Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))
      }),
      success: DiscoveredObjects,
      error: [EditingDisabled, TestBusy, TestInvalid, DiscoveryFailed]
    })
  )
  .add(
    HttpApiEndpoint.post("importCheck", "/api/import/check", {
      payload: ImportUpload,
      success: ImportCheck,
      error: [EditingDisabled, ConfigUnreadable]
    })
  )
  .add(
    HttpApiEndpoint.post("importApply", "/api/import/apply", {
      payload: Schema.Struct({ ...ImportUpload.fields, etag: Schema.String }),
      success: ImportApplied,
      error: [
        EditingDisabled,
        ImportInvalid,
        ConfigConflict,
        ConfigInvalid,
        ConfigUnreadable,
        ConfigWriteFailed,
        ConfigApplyFailed
      ]
    })
  ) {}
