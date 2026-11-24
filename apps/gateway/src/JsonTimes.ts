/**
 * Local times in the CLI's `--json` answers (`status`, `events`, `history`, `messages`). Every time stays Unix ms,
 * for scripts; next to each one is the same moment as a local ISO 8601 string with its UTC offset, named `<key>Local`
 * (`"at": 1795526463109, "atLocal": "2026-11-24T14:21:03.109+01:00"`), and the answer names the time zone it used
 * (`timeZone`, IANA). The zone is this machine's, the one the text output uses (`localTime`), so an agent can tell a
 * person "the meter stopped at 14:15:33" without converting, where jq's `todate` would give UTC.
 *
 * Only this CLI output: the gateway's HTTP API (`/api/*`) answers Unix ms alone, as before.
 */
import { localIsoTime, localTimeZone, printJson } from "./Output.ts"

/**
 * The keys that hold a time (Unix ms) in the answers, wherever they are. Explicit, never guessed from a number's
 * size: `test/JsonTimes.test.ts` fails when an API schema or a report gains a number that is neither here nor
 * named as something else there.
 */
export const TIME_KEYS: ReadonlySet<string> = new Set([
  "at",
  "configSince",
  "connectedAt",
  "detectedAt",
  "disconnectedSince",
  "emptyFrom",
  "emptyTo",
  "failingSince",
  "first",
  "from",
  "gatewayStarted",
  "last",
  "lastReadAt",
  "lastSuccess",
  "now",
  "recoveredAt",
  "since",
  "started",
  "t",
  "to",
  "ts"
])

/** Where a time key holds something else, by the `type` of the object it is in: a counter's readings. */
const NOT_TIMES_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  "counter-went-back": new Set(["from", "to"]),
  "counter-jumped": new Set(["from", "to"])
}

/**
 * Times left without a local string on purpose, by the key of the array they are in. A history bucket's `first`
 * and `last` read: up to 2,000 buckets per series, and the gaps (which have local times) are what they tell; the
 * bucket's start `t` keeps its `tLocal`.
 */
const UNLABELLED_UNDER: Readonly<Record<string, ReadonlySet<string>>> = {
  buckets: new Set(["first", "last"])
}

/** The name of the local string next to the time `key`. */
export const localTimeKey = (key: string) => `${key}Local`

const isTime = (key: string, value: unknown, type: string | undefined, parent: string | undefined) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  TIME_KEYS.has(key) &&
  !(type !== undefined && NOT_TIMES_BY_TYPE[type]?.has(key) === true) &&
  !(parent !== undefined && UNLABELLED_UNDER[parent]?.has(key) === true)

const walk = (value: unknown, parent: string | undefined): unknown => {
  if (Array.isArray(value)) return value.map((each) => walk(each, parent))
  if (typeof value !== "object" || value === null) return value
  return withLocalTimes(value, parent)
}

/**
 * `value` with `<key>Local` after each time in it, at any depth. JSON-shaped values only (what `--json` prints):
 * objects, arrays, strings, numbers, booleans.
 */
export const withLocalTimes = (value: object, parent?: string): Record<string, unknown> => {
  const type = "type" in value && typeof value.type === "string" ? value.type : undefined
  const result: Record<string, unknown> = {}
  for (const [key, each] of Object.entries(value)) {
    result[key] = walk(each, key)
    if (typeof each === "number" && isTime(key, each, type, parent)) result[localTimeKey(key)] = localIsoTime(each)
  }
  return result
}

/** A `--json` answer: its times with their local strings, and `timeZone` after `ok` (first when there is none). */
export const printJsonWithLocalTimes = (value: object) => {
  const timeZone = localTimeZone()
  const { ok, ...rest } = withLocalTimes(value)
  return printJson(ok === undefined ? { timeZone, ...rest } : { ok, timeZone, ...rest })
}

/** One NDJSON line (`events --follow --json`): its times with their local strings; every one carries its offset. */
export const jsonLineWithLocalTimes = (value: object) => JSON.stringify(withLocalTimes(value))
