/**
 * `ot-gateway support`: one file to attach to an issue report, with what a maintainer asks for first. In order:
 *
 *   versions and host  the CLI's version, Node, the OS, CPUs, memory, whether it runs in a container, the time zone
 *   config             the config file as it is (redacted), and whether it is valid
 *   environment        which OT_GATEWAY_* and OTEL_* variables are set, by name only
 *   status             the running gateway's status, as `status` and `status --json` print it
 *   events             what changed in the last 24 hours, as `events --since 24h` prints it
 *   logs               every line the gateway keeps in memory, as `logs --since all` prints it
 *
 * A section that cannot be filled (no config, no gateway running) says why, and the rest are still written: a bundle
 * is most needed when something is broken. The file is Markdown, readable in an issue and by an agent.
 *
 * Redacted: the broker password (the variable `mqtt.passwordEnv` names), `OT_GATEWAY_EDIT_TOKEN`, the values in
 * the `ot-gateway.env` next to the config whose names say they are secret (`*PASSWORD*`, `*TOKEN*`, `*KEY*`, …), the OTLP headers, credentials in a URL, and config keys that hold a
 * secret. Device addresses, ids and names stay: they are what a report is about, so the person attaching it reads it
 * first.
 */
import { brokerHostOf, type GatewayStatus } from "@ot-gateway/api"
import { Effect, FileSystem, Option, Result } from "effect"
import { arch, cpus, freemem, platform, release, totalmem, type as osType, uptime } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseEnv } from "node:util"
import { envFileName } from "./EnvFile.ts"
import { defaultConfigPath } from "./Import.ts"
import { checkIdentity, type GatewayTarget, targetOf } from "./GatewayTarget.ts"
import { loadConfig } from "./LoadConfig.ts"
import { fetchGatewayLogs, formatLogs } from "./LogsReport.ts"
import { localIsoTime, localTimeZone } from "./Output.ts"
import {
  devicesOf,
  fetchGatewayEvents,
  fetchGatewayStatus,
  formatEvents,
  formatStatus,
  gatewayServesEvents,
  recentIncidents,
  statusJson
} from "./StatusReport.ts"
import { readVersion } from "./Version.ts"

export const REDACTED = "<redacted>"

/** How far back the bundle's events go. */
export const EVENTS_WINDOW_MS = 24 * 60 * 60_000

/** Secrets shorter than this are not replaced in the text: a short value would match too much of it. */
const MIN_SECRET_LENGTH = 4

/** Config keys whose value is a secret, wherever they are: never in a valid config, but a file may be invalid. */
const secretKey = /(password|passwd|secret|token|api[-_]?key|credential)/i
/** A key that names where a secret is (`passwordEnv`), which is not one. */
const namesSecret = /env$/i

/** `value` with every key that holds a secret redacted, at any depth. */
export const redactJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactJson)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      secretKey.test(key) && !namesSecret.test(key) && inner !== null ? REDACTED : redactJson(inner)
    ])
  )
}

/** `text` without the credentials of any URL in it (`mqtt://user:pass@host`) and without each of `secrets`. */
export const redactText = (text: string, secrets: Iterable<string>) => {
  // Up to the last @ of the address, so a password with an @ or a / in it goes whole.
  let clean = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s"'<>]*@/gi, `$1${REDACTED}@`)
  // Longest first, so a secret that contains another is replaced whole.
  const sorted = [...new Set(secrets)].filter((secret) => secret.length >= MIN_SECRET_LENGTH)
  for (const secret of sorted.toSorted((left, right) => right.length - left.length)) {
    clean = clean.replaceAll(secret, REDACTED)
  }
  return clean
}

/** A variable whose value is a secret, by its name. */
const secretVariable = /(PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIAL|HEADERS)/i

/** The values to redact: the env file's next to the config, and the variables that hold a secret. */
export const secretsOf = (
  env: Readonly<Record<string, string | undefined>>,
  envFileText: string | undefined,
  passwordEnv: string | undefined
) => {
  // Only the env file's variables that hold a secret by their name: TZ or OTEL_SERVICE_NAME would blank out text.
  const fromFile =
    envFileText === undefined
      ? []
      : Object.entries(parseEnv(envFileText))
          .filter(([name]) => secretVariable.test(name) || name === passwordEnv)
          .map(([, value]) => value)
  const named = [passwordEnv, "MQTT_PASSWORD", "OT_GATEWAY_EDIT_TOKEN"].flatMap((name) => {
    const value = name === undefined ? undefined : env[name]
    return value === undefined || value === "" ? [] : [value]
  })
  // `Authorization=Basic abc,x-api-key=def`: the whole value and each header's value.
  const headers = env["OTEL_EXPORTER_OTLP_HEADERS"] ?? ""
  const headerValues =
    headers === "" ? [] : [headers, ...headers.split(",").map((pair) => pair.slice(pair.indexOf("=") + 1).trim())]
  return [...fromFile, ...named, ...headerValues].filter(
    (value): value is string => value !== undefined && value !== ""
  )
}

/** The names of the variables that set up the gateway and its telemetry, never their values. */
export const settingNames = (env: Readonly<Record<string, string | undefined>>) =>
  Object.keys(env)
    .filter((name) => /^(OT_GATEWAY_|OTEL_)/.test(name) && env[name] !== undefined && env[name] !== "")
    .toSorted()

export interface SupportSection {
  readonly name: "host" | "config" | "environment" | "status" | "events" | "logs"
  /** Whether it holds what it is for; when not, `note` says why. */
  readonly ok: boolean
  readonly note: string
  /** The section's Markdown, without its heading. */
  readonly body: string
}

export interface SupportBundle {
  readonly text: string
  readonly sections: ReadonlyArray<SupportSection>
}

const fenced = (text: string, language = "") => `\`\`\`${language}\n${text.replace(/```/g, "'''")}\n\`\`\``

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

const hostSection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const version = yield* readVersion
  const inContainer =
    (yield* fs.exists("/.dockerenv").pipe(Effect.orElseSucceed(() => false))) ||
    (yield* fs.exists("/run/.containerenv").pipe(Effect.orElseSucceed(() => false)))
  const processors = cpus()
  const lines = [
    `- ot-gateway (this CLI): ${version}`,
    `- Node: ${process.version}`,
    `- OS: ${osType()} ${release()} (${platform()}, ${arch()})${inContainer ? ", in a container" : ""}`,
    `- CPUs: ${processors.length} × ${processors[0]?.model.trim() ?? "unknown"}`,
    `- Memory: ${megabytes(freemem())} free of ${megabytes(totalmem())}`,
    `- Up: ${Math.round(uptime() / 3600)} h`,
    `- Time zone: ${localTimeZone()}`
  ]
  return {
    name: "host",
    ok: true,
    note: `ot-gateway ${version}, Node ${process.version}`,
    body: lines.join("\n")
  } satisfies SupportSection
})

/** The config file's text, as JSON with its secrets redacted when it is JSON, else as it is. */
export const configText = (text: string) => {
  const parsed = Result.try((): unknown => JSON.parse(text))
  if (Result.isSuccess(parsed)) return JSON.stringify(redactJson(parsed.success), null, 2)
  // Not JSON: the value after each key that holds a secret, as far as a string or a word goes.
  return text.replace(/("([^"]*)"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,{}[\]"]+)/g, (whole, head: string, key: string) =>
    secretKey.test(key) && !namesSecret.test(key) ? `${head}"${REDACTED}"` : whole
  )
}

const notFilled = (name: SupportSection["name"], note: string): SupportSection => ({
  name,
  ok: false,
  note,
  body: `Not available: ${note}`
})

export interface SupportOptions {
  /** The config's path; ot-gateway.json in this folder when none is named. */
  readonly config?: string | undefined
  /** Ask the status page here instead of the config's. */
  readonly url?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Unix ms: when the bundle is written. */
  readonly now: number
}

/** The bundle for the gateway of `options.config`: each section, and the whole Markdown, redacted. */
export const supportBundle = Effect.fn("supportBundle")(function* (options: SupportOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = options.config ?? defaultConfigPath
  const host = yield* hostSection

  // The config: the file as it is, then whether it is valid. loadConfig reads the env file next to it too.
  const raw = yield* fs.readFileString(path).pipe(Effect.option)
  const loaded = Option.isNone(raw) ? undefined : yield* Effect.result(loadConfig(path))
  const config = loaded !== undefined && Result.isSuccess(loaded) ? loaded.success : undefined
  const env = options.env ?? process.env
  const envFile = yield* fs
    .readFileString(join(dirname(resolve(path)), envFileName))
    .pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const secrets = secretsOf(env, envFile, config?.mqtt.passwordEnv)
  const configSection: SupportSection = Option.isNone(raw)
    ? notFilled("config", `no config at ${path}`)
    : {
        name: "config",
        ok: config !== undefined,
        note:
          config !== undefined
            ? `valid: ${config.devices.length} device(s), ${config.devices.reduce((sum, device) => sum + device.points.length, 0)} point(s)`
            : "not valid",
        body: [
          loaded === undefined || Result.isSuccess(loaded)
            ? `${path} is a valid config.`
            : fenced(loaded.failure.message),
          "",
          fenced(configText(raw.value), "json")
        ].join("\n")
      }
  const names = settingNames(env)
  const environment: SupportSection = {
    name: "environment",
    ok: true,
    note: `${names.length} variable(s)`,
    body:
      names.length === 0
        ? "No OT_GATEWAY_* or OTEL_* variables are set."
        : names.map((name) => `- ${name} (set)`).join("\n")
  }

  // The running gateway: the config's, or the one at --url.
  const target = yield* Effect.gen(function* () {
    // --url and no config named: whichever gateway answers there, as status asks it.
    if (options.url !== undefined && options.config === undefined) return { url: options.url } satisfies GatewayTarget
    if (config !== undefined) return yield* targetOf(path, config, options.url)
    return undefined
  }).pipe(Effect.catchTag("NoStatusPage", (error) => Effect.succeed(error.message)))
  const gateway = yield* gatewaySections(target)

  const sections = [host, configSection, environment, ...gateway]
  const heading: Record<SupportSection["name"], string> = {
    host: "Versions and host",
    config: `Config (${path})`,
    environment: "Environment",
    status: "Status",
    events: "Events, last 24 hours",
    logs: "Logs, all the gateway keeps"
  }
  const text = [
    "# OT Gateway support bundle",
    "",
    `Written ${localIsoTime(options.now)} by ot-gateway support. Secrets are redacted; device addresses, ids and names are not, so read it before you attach it.`,
    ...sections.flatMap((section) => ["", `## ${heading[section.name]}`, "", section.body])
  ].join("\n")
  return { text: `${redactText(text, secrets)}\n`, sections } satisfies SupportBundle
})

/** Status, events and logs from the gateway at `target`; why not, when there is no target or it does not answer. */
const gatewaySections = Effect.fnUntraced(function* (target: GatewayTarget | string | undefined) {
  if (target === undefined || typeof target === "string") {
    const note = target ?? "no valid config to find the gateway with, and no --url"
    return [notFilled("status", note), notFilled("events", note), notFilled("logs", note)]
  }
  const answer = yield* fetchGatewayStatus(target.url, "none").pipe(
    Effect.tap((status) => checkIdentity(target, status)),
    Effect.map((status): GatewayStatus | string => status),
    Effect.catchTags({
      GatewayUnreachable: (error) => Effect.succeed(`${error.message} (${error.code})`),
      GatewayAnswerUnreadable: (error) => Effect.succeed(`${error.message} (${error.code})`),
      GatewayMismatch: (error) => Effect.succeed(`${error.message} (${error.code})`)
    })
  )
  if (typeof answer === "string")
    return [notFilled("status", answer), notFilled("events", answer), notFilled("logs", answer)]
  const status = answer
  const serves = yield* gatewayServesEvents(target.url, status)
  const log = serves
    ? yield* fetchGatewayEvents(target.url).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          GatewayUnreachable: () => Effect.succeedNone,
          GatewayAnswerUnreadable: () => Effect.succeedNone
        })
      )
    : Option.none()
  const recent = Option.isSome(log) ? recentIncidents(log.value) : undefined
  const statusSection: SupportSection = {
    name: "status",
    ok: true,
    note: `${status.site}/${status.building} gateway ${status.id} at ${target.url}`,
    body: [
      fenced(formatStatus(status, recent)),
      "",
      fenced(JSON.stringify(statusJson(status, recent), null, 2), "json")
    ].join("\n")
  }
  const eventsSection: SupportSection = Option.isNone(log)
    ? notFilled(
        "events",
        serves ? "the gateway did not answer for its events" : "the gateway is too old to keep events"
      )
    : {
        name: "events",
        ok: true,
        note: `${log.value.events.length} kept`,
        body: fenced(
          formatEvents(log.value, EVENTS_WINDOW_MS, "24h", devicesOf(status), {
            brokerHost: brokerHostOf(status.broker.url),
            started: status.since
          })
        )
      }
  const page = yield* fetchGatewayLogs(target.url).pipe(
    Effect.catchTags({
      GatewayUnreachable: () => Effect.succeedNone,
      GatewayAnswerUnreadable: () => Effect.succeedNone
    })
  )
  const logsSection: SupportSection = Option.isNone(page)
    ? notFilled(
        "logs",
        "the gateway keeps no log lines to ask for (a release before the logs command), or did not answer"
      )
    : {
        name: "logs",
        ok: true,
        note: `${page.value.lines.length} line(s)`,
        body: fenced(formatLogs(page.value, { since: "all", sinceMs: Number.POSITIVE_INFINITY, level: "info" }))
      }
  return [statusSection, eventsSection, logsSection]
})

const two = (value: number) => String(value).padStart(2, "0")

/** `ot-gateway-support-20261126-170809.md`: the default file name, in local time. */
export const supportFileName = (now: number) => {
  const at = new Date(now)
  return `ot-gateway-support-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.md`
}

/**
 * What `support` prints after writing the bundle: where it is, and one line per section; sections that could not be
 * filled for the same reason (no gateway answering) share a line.
 */
export const formatSupportSummary = (path: string, bundle: SupportBundle) => {
  const groups: Array<{ names: Array<string>; section: SupportSection }> = []
  for (const section of bundle.sections) {
    const last = groups.at(-1)
    if (last !== undefined && !section.ok && !last.section.ok && last.section.note === section.note) {
      last.names.push(section.name)
    } else groups.push({ names: [section.name], section })
  }
  return [
    `wrote ${path} (${Math.max(1, Math.round(Buffer.byteLength(bundle.text) / 1024))} KB)`,
    ...groups.map(
      ({ names, section }) => `  ${names.join(", ")}: ${section.ok ? "" : "not available: "}${section.note}`
    ),
    "Secrets are redacted; device addresses, ids and names are not. Read it before you attach it to an issue."
  ].join("\n")
}
