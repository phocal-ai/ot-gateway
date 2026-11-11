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
