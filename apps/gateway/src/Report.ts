/**
 * `ot-gateway report`: a bug in ot-gateway itself, written up by the agent that hit it and filed only after the
 * user has read it. Two steps, so the text exists before anything is sent:
 *
 *   report draft   the issue text from what the agent saw (what happened, expected, steps, what it ruled out), with
 *                  the versions and host added, written to a file. It says whether a newer release is out, what
 *                  the code means when the failure has one, and which issues already carry the same fingerprint.
 *   report send    files that file: with a signed-in `gh` and --yes as an issue (or, with --to, as a comment on the
 *                  issue that already reports it), otherwise as a link that opens the issue form filled in.
 *                  Without a GitHub account the file is what the user passes on.
 *
 * The issue is public, so the text is stricter than `support`'s bundle: besides secrets, the config's site, building,
 * device and point ids, point names, host names and the broker login are replaced by placeholders (`device-1`), and so
 * are IP and MAC addresses, e-mail addresses, the hosts of URLs, this machine's name and the home folder. The same
 * pass runs on the draft and again on what `send` files, so a line added to the draft by hand is covered too. What
 * stays is what a bug is about: the protocol, register addresses, object types and instances, the device's vendor
 * and model, versions.
 *
 * The fingerprint is a hash of the code, the command and the error with every number and placeholder taken out, so
 * the same bug on two sites has the same one; `draft` searches the repository's issues for it.
 *
 * Nothing here runs on its own and no report leaves the machine without --yes: there is no setting that files
 * without asking.
 */
import type { GatewayConfig } from "@ot-gateway/core"
import {
  Context,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Result,
  Schema,
  Stream
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createHash } from "node:crypto"
import { arch, homedir, hostname, platform, release, type as osType } from "node:os"
import { dirname, join, resolve } from "node:path"
import { findCode } from "./Codes.ts"
import { envFileName } from "./EnvFile.ts"
import { latestRelease as newestRelease } from "./Deploy.ts"
import { compareReleases, parseRelease, versionName } from "./GatewayRelease.ts"
import { defaultConfigPath } from "./Import.ts"
import { loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"
import { REDACTED, redactText, secretsOf } from "./Support.ts"
import { readVersion } from "./Version.ts"
import { plural } from "./Words.ts"

/** Where reports go. */
export const REPORT_REPOSITORY = "phocal-ai/ot-gateway"
const ISSUES_URL = `https://github.com/${REPORT_REPOSITORY}/issues`

/** The longest text `send` files: an issue is the lines that show the failure, not a log. */
export const MAX_REPORT_LENGTH = 16_000

/** A link longer than this is cut by browsers and by GitHub, so the body is then pasted from the file instead. */
const MAX_LINK_LENGTH = 6_000

/** A report could not be written or filed. */
export class ReportFailed extends Schema.TaggedError<ReportFailed>()("ReportFailed", {
  message: Schema.String,
  code: Schema.Literals(["report-draft-invalid", "report-not-filed", "report-unconfirmed"]),
  hint: Schema.optionalKey(Schema.String),
  next: Schema.optionalKey(Schema.String)
}) {}

// ---------------------------------------------------------------------------------------------------------------
// What a public issue must not carry

/** What was replaced, by kind, for the summary: `{ device: 3, address: 2 }`. */
export type Replaced = Readonly<Record<string, number>>

interface Identifier {
  readonly kind: string
  readonly value: string
  readonly placeholder: string
  /** Free text (a point's name) rather than an id: matched without regard to case. */
  readonly phrase?: boolean
}

/** An identifier shorter than this is left: `t1` or `a` as a word would match too much of the text. */
const MIN_IDENTIFIER_LENGTH = 3

/** A value that is one of our placeholders already says nothing about a site. */
const isPlaceholder = (value: string) => /^(site|building|gateway|device|point|host|ip|mac)-\d+$/.test(value)

/** Words the draft itself is made of: a site called `ot-gateway` must not rewrite the line that carries the fingerprint. */
const reserved = new Set([
  "ot-gateway",
  "otg",
  "ot-gateway-report",
  "fingerprint",
  // The draft's own labels, and the commands: a point called `status` or `Error` would otherwise rewrite the
  // command line on this site only, and with it the fingerprint.
  "command",
  "code",
  "error",
  "protocol",
  "node",
  "expected",
  "device",
  "point",
  "site",
  "building",
  "gateway",
  "check",
  "config",
  "contract",
  "demo",
  "diff",
  "discover",
  "doctor",
  "down",
  "events",
  "explain",
  "guide",
  "history",
  "import",
  "init",
  "logs",
  "mcp",
  "messages",
  "points",
  "probe",
  "profiles",
  "publish",
  "read",
  "report",
  "restart",
  "run",
  "secret",
  "simulate",
  "start",
  "status",
  "stop",
  "support",
  "upgrade",
  "watch",
  "write",
  "gateways",
  "broker"
])

/** A name worth replacing: long enough to be one, not a placeholder already, and not a word of the draft itself. */
const replaceable = (value: string) =>
  value.trim().length >= MIN_IDENTIFIER_LENGTH && !isPlaceholder(value) && !reserved.has(value.toLowerCase())

const isAddress = (host: string) => /^[\d.]+$/.test(host) || host.includes(":")

/** Hosts that name no site: this machine, GitHub, and the public test brokers the demo uses. */
const publicHosts = new Set([
  "localhost",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "ghcr.io",
  "registry.npmjs.org",
  "www.npmjs.com",
  "get.docker.com",
  "broker.hivemq.com",
  "broker.emqx.io",
  "test.mosquitto.org",
  "example.com",
  "host"
])

const hostOfUrl = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^/:\s]+)/i.exec(url)?.[1]

/**
 * The config's names, each with the placeholder that stands for it: the site, the building, the gateway's id unless
 * it is the default, every device and point id, point names that are not their id, host names of devices, the broker
 * and the status page, and the broker's login and client id. Numbered in the config's order, so the same device is
 * the same placeholder everywhere in a report.
 */
export const identifiersOf = (config: GatewayConfig): ReadonlyArray<Identifier> => {
  const found: Array<Identifier> = [
    { kind: "site", value: config.site, placeholder: "site-1" },
    { kind: "building", value: config.building, placeholder: "building-1" }
  ]
  // `main` is what every gateway is called that was not given an id.
  if (config.id !== "main") found.push({ kind: "gateway", value: config.id, placeholder: "gateway-1" })
  const hosts: Array<string> = []
  const brokerHost = hostOfUrl(config.mqtt.url)
  if (brokerHost !== undefined) hosts.push(brokerHost)
  const pointIds: Array<string> = []
  const pointNames: Array<readonly [name: string, id: string]> = []
  config.devices.forEach((device, index) => {
    found.push({ kind: "device", value: device.id, placeholder: `device-${index + 1}` })
    if (device.protocol === "modbus-tcp") hosts.push(device.host)
    for (const point of device.points) {
      if (!pointIds.includes(point.id)) pointIds.push(point.id)
      if (point.name !== point.id) pointNames.push([point.name, point.id])
    }
  })
  pointIds.forEach((id, index) => {
    found.push({ kind: "point", value: id, placeholder: `point-${index + 1}` })
  })
  for (const [name, id] of pointNames) {
    found.push({ kind: "point", value: name, placeholder: `point-${pointIds.indexOf(id) + 1}`, phrase: true })
  }
  hosts.push(...(config.status?.hostNames ?? []))
  const named = [...new Set(hosts)].filter((host) => !isAddress(host) && !publicHosts.has(host.toLowerCase()))
  named.forEach((host, index) => {
    found.push({ kind: "host", value: host, placeholder: `host-${index + 1}`, phrase: true })
  })
  if (config.mqtt.username !== undefined) {
    found.push({ kind: "login", value: config.mqtt.username, placeholder: "broker-login" })
  }
  if (config.mqtt.clientId !== undefined) {
    found.push({ kind: "login", value: config.mqtt.clientId, placeholder: "client-id" })
  }
  return found.filter((each) => replaceable(each.value) && each.value !== each.placeholder)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Not inside a longer word or id: `meter` is not replaced in `meter-2` or `kilometer`. */
const asWord = (value: string, flags: string) =>
  new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`, flags)

/**
 * The placeholders given so far for addresses and unknown hosts. One report shares one of these over all its texts,
 * so an address is the same placeholder in the title and in the steps, and two addresses never share one.
 */
export interface Numbers {
  readonly seen: Map<string, string>
  readonly last: Map<string, number>
}

export const newNumbers = (): Numbers => ({ seen: new Map(), last: new Map() })

/**
 * The next free placeholder such as `ip-3`: after the ones `numbers` gave, the ones the text has (a second pass over
 * a draft) and `floor` (the config's own `host-N`).
 */
const numbering = (text: string, prefix: string, numbers: Numbers, floor = 0) => {
  let last = Math.max(numbers.last.get(prefix) ?? 0, floor)
  for (const match of text.matchAll(new RegExp(`(?<![A-Za-z0-9_-])${prefix}-(\\d+)(?![A-Za-z0-9_-])`, "g"))) {
    last = Math.max(last, Number(match[1]))
  }
  numbers.last.set(prefix, last)
  return (value: string) => {
    const key = `${prefix} ${value.toLowerCase()}`
    const known = numbers.seen.get(key)
    if (known !== undefined) return known
    const next = (numbers.last.get(prefix) ?? 0) + 1
    numbers.last.set(prefix, next)
    const placeholder = `${prefix}-${next}`
    numbers.seen.set(key, placeholder)
    return placeholder
  }
}

/** What comes right before a run of bytes that is a frame, not a hardware address. */
const bytesBefore = /(frame|bytes?|pdu|adu|apdu|npdu|hex|payload|request|response|data|sent|received|rx|tx)\W{0,3}$/i

/** What comes right before four dotted numbers that are a version, not an address. */
const versionBefore = /(version|firmware|fw|rev|revision|release|build|\bv)\W{0,2}$/i

/** Addresses that are the same on every machine. */
const sharedIpv4 = (address: string) =>
  address.startsWith("127.") || address === "0.0.0.0" || address === "255.255.255.255"

export interface PublicTextOptions {
  /** The config's names (`identifiersOf`); none when no config could be read. */
  readonly identifiers?: ReadonlyArray<Identifier>
  /** Secret values, as `support` finds them (`secretsOf`). */
  readonly secrets?: Iterable<string>
  /** This machine's name and the user's home folder; left out in tests. */
  readonly machine?: { readonly hostname: string; readonly home: string }
  /** The placeholders given so far, when this text is one of several of a report. */
  readonly numbers?: Numbers
}

/**
 * `text` as a public issue may carry it: secrets and a URL's credentials redacted, the config's names, addresses
 * and the machine's own name replaced by placeholders. Running it on its own result changes nothing.
 */
export const publicText = (text: string, options: PublicTextOptions = {}) => {
  const counts: Record<string, number> = {}
  const count = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  const secrets = [...(options.secrets ?? [])]
  // Not `<redacted>`: GitHub would render it as a tag, which is nothing.
  let clean = redactText(text, secrets).replaceAll(REDACTED, "[redacted]")
  if (clean !== text) count("secret")

  const home = options.machine?.home ?? ""
  if (home.length > 1) {
    clean = clean.replaceAll(home, () => {
      count("home")
      return "~"
    })
  }
  // Any other user's home folder a path names.
  clean = clean.replace(
    /(\/(?:home|Users)\/|[A-Za-z]:\\Users\\)([^/\\\s"'`]+)/g,
    (whole, head: string, name: string) => {
      if (name === "user") return whole
      count("home")
      return `${head}user`
    }
  )

  // The config's names, the longest first, so an id that contains another is replaced whole.
  const machine = options.machine?.hostname ?? ""
  const identifiers = [
    ...(options.identifiers ?? []),
    ...(replaceable(machine) && !publicHosts.has(machine.toLowerCase())
      ? [{ kind: "host", value: machine, placeholder: "this-machine", phrase: true }]
      : [])
  ].toSorted((left, right) => right.value.length - left.value.length)
  for (const identifier of identifiers) {
    clean = clean.replace(asWord(identifier.value, identifier.phrase === true ? "gi" : "g"), () => {
      count(identifier.kind)
      return identifier.placeholder
    })
  }

  clean = clean.replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, () => {
    count("email")
    return "email"
  })
  const numbers = options.numbers ?? newNumbers()
  const mac = numbering(clean, "mac", numbers)
  // Six bytes, unless the words before them say they are a frame's.
  clean = clean.replace(
    /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}(?![0-9A-Fa-f:-])/g,
    (address, offset: number, whole: string) => {
      if (bytesBefore.test(whole.slice(Math.max(0, offset - 16), offset))) return address
      count("address")
      return mac(address)
    }
  )
  const ip = numbering(clean, "ip", numbers)
  // Four numbers up to 255, not part of a longer dotted number and not a version (`firmware 2.1.0.14`).
  clean = clean.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d]|\.\d)/g, (address, offset: number, whole: string) => {
    if (sharedIpv4(address) || address.split(".").some((part) => Number(part) > 255)) return address
    if (versionBefore.test(whole.slice(Math.max(0, offset - 12), offset))) return address
    count("address")
    return ip(address)
  })
  // IPv6: four or more groups with one of three or four digits, or a `::` between groups. A clock time has three
  // groups, and a frame's bytes (`00:01:00:00:00:05`) two digits each.
  clean = clean.replace(
    /(?<![\w:.])(?:(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,5})?)(?![\w:.])/g,
    (address) => {
      if (!address.includes("::") && !/[0-9A-Fa-f]{3}/.test(address)) return address
      count("address")
      return ip(address)
    }
  )
  // A URL's host that is none of the above: a name the config does not hold.
  const hostFloor = Math.max(
    0,
    ...(options.identifiers ?? []).map((each) => Number(/^host-(\d+)$/.exec(each.placeholder)?.[1] ?? 0))
  )
  const host = numbering(clean, "host", numbers, hostFloor)
  clean = clean.replace(
    /\b((?:mqtts?|wss?|https?|tcp):\/\/(?:[^@/\s]*@)?)([^/:\s"'`<>)\]]+)/gi,
    (whole, head: string, name: string) => {
      const lower = name.toLowerCase()
      if (publicHosts.has(lower) || lower.endsWith(".github.com") || isAddress(name)) return whole
      if (/^(ip|host)-\d+$|^this-machine$/.test(lower)) return whole
      count("host")
      return `${head}${host(name)}`
    }
  )
  return { text: clean, replaced: counts satisfies Replaced }
}

// ---------------------------------------------------------------------------------------------------------------
// The fingerprint

/** The command's own words, without how it was started and without its arguments: `points allow-commands`. */
export const commandWords = (command: string) => {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "")
  const start = words.findIndex((word) => /^(ot-gateway(@[\w.-]+)?|otg)$/.test(word))
  const rest = start < 0 ? words : words.slice(start + 1)
  const groups = new Set(["points", "config", "gateways", "secret", "profiles", "report", "guide"])
  const [first, second] = rest
  if (first === undefined || first.startsWith("-")) return ""
  return groups.has(first) && second !== undefined && /^[a-z][a-z-]*$/.test(second) ? `${first} ${second}` : first
}

/** A line without what differs from site to site: numbers, placeholders, quotes, case and spacing. */
const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/\b(site|building|gateway|device|point|host|ip|mac)-\d+\b/g, "$1")
    .replace(/\d+/g, "n")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Twelve hex digits that are the same for the same bug on another site: from the code, the command and the error
 * (already public text). A report with none of them falls back on its title.
 */
export const fingerprintOf = (parts: {
  readonly code?: string | undefined
  readonly command?: string | undefined
  readonly error?: string | undefined
  readonly title: string
}) => {
  const error = normalized(parts.error ?? "")
  const key = [parts.code ?? "", commandWords(parts.command ?? ""), error === "" ? normalized(parts.title) : error]
  return createHash("sha256").update(key.join("\n")).digest("hex").slice(0, 12)
}

const fingerprintMarker = (fingerprint: string) => `<!-- ot-gateway-report fingerprint: ${fingerprint} -->`

/** The fingerprint a draft carries. */
export const fingerprintIn = (text: string) => /<!-- ot-gateway-report fingerprint: ([0-9a-f]{12}) -->/.exec(text)?.[1]

// ---------------------------------------------------------------------------------------------------------------
// GitHub

/** An issue as a search finds it. */
export interface IssueRef {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: string
}

/** What one `gh` command did. */
export interface GhResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** `gh` did not finish in time: what it was asked to do may or may not have happened. */
export class GhTimedOut extends Schema.TaggedError<GhTimedOut>()("GhTimedOut", { message: Schema.String }) {}

/** GitHub as a report needs it: the public issue search, and the user's own `gh` to file with. */
export class GitHub extends Context.Service<
  GitHub,
  {
    /** Issues of the repository that match `query`, without signing in. */
    readonly searchIssues: (query: string) => Effect.Effect<ReadonlyArray<IssueRef>, ReportFailed>
    /** Runs `gh <args>`; none when there is no `gh` on this machine to start. */
    readonly gh: (args: ReadonlyArray<string>) => Effect.Effect<Option.Option<GhResult>, GhTimedOut>
    /** The newest release's tag, when GitHub says. */
    readonly latestRelease: Effect.Effect<Option.Option<string>>
  }
>()("@ot-gateway/gateway/GitHub") {}

const SearchAnswer = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ number: Schema.Int, title: Schema.String, html_url: Schema.String, state: Schema.String })
  )
})
const GITHUB_TIMEOUT: Duration.Input = "10 seconds"
const GH_TIMEOUT: Duration.Input = "30 seconds"

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.mkString(Stream.decodeText(stream))

/** The public issue search: no login, and a deadline. */
const searchIssues = (query: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      `https://api.github.com/search/issues?per_page=5&q=${encodeURIComponent(`repo:${REPORT_REPOSITORY} is:issue ${query}`)}`,
      { headers: { accept: "application/vnd.github+json" } }
    )
    const ok = yield* HttpClientResponse.filterStatusOk(response)
    const answer = yield* Effect.flatMap(ok.json, Schema.decodeUnknownEffect(SearchAnswer))
    return answer.items.map((item): IssueRef => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      state: item.state
    }))
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.timeout(GITHUB_TIMEOUT),
    // Every failure here means one thing: it is not known whether the issue exists already.
    Effect.mapError(
      (error) =>
        new ReportFailed({
          code: "report-not-filed",
          message: `could not search the issues on GitHub: ${error.message}`
        })
    )
  )

/** GitHub's API without a login, and the `gh` on this machine's PATH. */
export const gitHubLayer = Layer.effect(
  GitHub,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const gh = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("gh", args, { stdin: "ignore" }))
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" }
          )
          return { exitCode: Number(exitCode), stdout, stderr } satisfies GhResult
        })
      ).pipe(
        // Not started (no gh on the PATH) is an answer; not finished is not one.
        Effect.option,
        Effect.timeoutOrElse({
          duration: GH_TIMEOUT,
          orElse: () =>
            Effect.fail(new GhTimedOut({ message: `gh ${args.slice(0, 2).join(" ")} did not finish within 30 s` }))
        })
      )
    const latestRelease = newestRelease.pipe(
      Effect.map((newest) => newest.tag),
      Effect.option
    )
    return GitHub.of({ searchIssues, gh, latestRelease })
  })
)

// ---------------------------------------------------------------------------------------------------------------
// draft

export interface DraftInput {
  /** One line that names the bug. */
  readonly title: string
  /** What happened: the lines that show the failure. */
  readonly what: string
  readonly expected?: string | undefined
  /** The commands that lead to it, in order. */
  readonly steps?: string | undefined
  /** What was checked and is not the cause (wiring, the config, an older release). */
  readonly ruledOut?: string | undefined
  /** The command that failed, as it was run. */
  readonly command?: string | undefined
  /** The code the command printed, when it printed one. */
  readonly code?: string | undefined
  /** The error's message, one line. */
  readonly error?: string | undefined
  /** The device's vendor, model and firmware, when the bug is about a device. */
  readonly model?: string | undefined
  /** The config's device the bug is about: its protocol is added. */
  readonly device?: string | undefined
}

export interface DraftOptions {
  readonly input: DraftInput
  /** The config's path; ot-gateway.json in this folder when none is named. */
  readonly config?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The CLI as the user runs it, for the next command. */
  readonly cli: string
  /** Where the draft is written. */
  readonly output: string
  /** This machine's name and home folder; the real ones when left out. */
  readonly machine?: { readonly hostname: string; readonly home: string }
}

/** Something to settle before the report is worth filing. */
export interface DraftWarning {
  readonly about: "release" | "code" | "config" | "search"
  readonly message: string
  readonly next?: string
}

export interface ReportDraft {
  readonly path: string
  readonly title: string
  /** The whole draft: the title's line and the issue's text. */
  readonly text: string
  readonly fingerprint: string
  readonly replaced: Replaced
  /** Issues that carry the same fingerprint: the same bug, reported before. */
  readonly existing: ReadonlyArray<IssueRef>
  readonly warnings: ReadonlyArray<DraftWarning>
  /** The command that shows what `send` would file. */
  readonly next: string
}

const section = (heading: string, body: string | undefined) =>
  body === undefined || body.trim() === "" ? [] : ["", `## ${heading}`, "", body.trim()]

/** The config and what to replace of it; nothing when there is none to read, which the draft then says. */
const readSite = Effect.fnUntraced(function* (
  path: string,
  env: Readonly<Record<string, string | undefined>>,
  machine: PublicTextOptions["machine"]
) {
  const fs = yield* FileSystem.FileSystem
  const loaded = yield* Effect.result(loadConfig(path))
  const config = Result.isSuccess(loaded) ? loaded.success : undefined
  const envFile = yield* fs
    .readFileString(join(dirname(resolve(path)), envFileName))
    .pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const options: PublicTextOptions = {
    identifiers: config === undefined ? [] : identifiersOf(config),
    secrets: secretsOf(env, envFile, config?.mqtt.passwordEnv),
    machine: machine ?? { hostname: hostname(), home: homedir() }
  }
  return { config, options }
})

const noConfigWarning = (path: string): DraftWarning => ({
  about: "config",
  message: `no valid config at ${path}: addresses were replaced, but site, device and point names could not be. Read the text for them`
})

const addCounts = (left: Replaced, right: Replaced): Replaced => {
  const sum: Record<string, number> = { ...left }
  for (const [kind, count] of Object.entries(right)) sum[kind] = (sum[kind] ?? 0) + count
  return sum
}

const two = (value: number) => String(value).padStart(2, "0")

/** `ot-gateway-report-20261126-170809.md`: the default file name, in local time. */
export const reportFileName = (now: number) => {
  const at = new Date(now)
  return `ot-gateway-report-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.md`
}

/** The `report send` line for a draft, with the config it was made with, so the second pass replaces the same names. */
const sendLine = (given: {
  readonly cli: string
  readonly draft: string
  readonly config?: string | undefined
  readonly to?: number | undefined
  readonly flag?: "--yes" | "--link"
}) =>
  [
    `${given.cli} report send ${shellArgument(given.draft)}`,
    ...(given.config === undefined ? [] : [`--config ${shellArgument(given.config)}`]),
    ...(given.to === undefined ? [] : [`--to ${given.to}`]),
    ...(given.flag === undefined ? [] : [given.flag])
  ].join(" ")

/** The draft of a report: its text in a file, and what to settle before it is filed. Sends nothing but a search. */
export const draftReport = Effect.fn("draftReport")(function* (options: DraftOptions) {
  const fs = yield* FileSystem.FileSystem
  const github = yield* GitHub
  const { input } = options
  const path = options.config ?? defaultConfigPath
  const site = yield* readSite(path, options.env ?? process.env, options.machine)
  let replaced: Replaced = {}
  // One numbering for every part, so an address is the same placeholder in the title and in the steps.
  const numbers = newNumbers()
  const clean = (text: string) => {
    const result = publicText(text, { ...site.options, numbers })
    replaced = addCounts(replaced, result.replaced)
    return result.text
  }
  const title = clean(input.title).replace(/\s+/g, " ").trim()
  if (title === "" || input.what.trim() === "") {
    return yield* new ReportFailed({
      code: "report-draft-invalid",
      message: "a report needs a title and what happened",
      hint: "Name the bug in one line (--title) and give the lines that show it (--what)"
    })
  }

  const version = yield* readVersion
  const newest = yield* github.latestRelease
  const warnings: Array<DraftWarning> = []
  const mine = parseRelease(version)
  const theirs = Option.isSome(newest) ? parseRelease(newest.value) : undefined
  const behind = mine !== undefined && theirs !== undefined && compareReleases(mine, theirs) < 0
  if (behind && Option.isSome(newest)) {
    warnings.push({
      about: "release",
      message: `this is ${versionName(version)} and ${newest.value} is out: try again with it first, the bug may be fixed`,
      next: `${options.cli} upgrade --check`
    })
  }
  if (site.config === undefined) warnings.push(noConfigWarning(path))
  // `bug` is the one code that says the fault is ours: nothing on the site to rule out first.
  const known = input.code === undefined || input.code === "bug" ? undefined : findCode(input.code)
  if (known !== undefined) {
    warnings.push({
      about: "code",
      message: `${known.code} is a code ot-gateway reports on purpose: ${known.meaning} Report it only when this does not help: ${known.fix}`,
      next: `${options.cli} explain ${known.code}`
    })
  }

  const error = input.error === undefined ? undefined : clean(input.error).replace(/\s+/g, " ").trim()
  const command = input.command === undefined ? undefined : clean(input.command).replace(/\s+/g, " ").trim()
  // The command's own words from the command as it was run: cleaned, a point called like a command would change them.
  const fingerprint = fingerprintOf({ code: input.code, command: input.command, error, title })
  const device = site.config?.devices.find((each) => each.id === input.device)
  const deviceLines = [
    ...(device === undefined ? [] : [`- Protocol: ${device.protocol}`]),
    ...(input.model === undefined || input.model.trim() === "" ? [] : [`- Vendor and model: ${clean(input.model)}`])
  ]
  const text = [
    `# ${title}`,
    "",
    fingerprintMarker(fingerprint),
    "",
    "Written by an agent with `ot-gateway report` and read by the user before it was filed. Site, device and point names and addresses are replaced by placeholders.",
    "",
    `- Fingerprint: \`${fingerprint}\``,
    ...(command === undefined || command === "" ? [] : [`- Command: \`${command.replace(/`/g, "'")}\``]),
    ...(input.code === undefined ? [] : [`- Code: \`${clean(input.code).replace(/`/g, "'")}\``]),
    ...(error === undefined || error === "" ? [] : [`- Error: ${error}`]),
    ...section("What happened", clean(input.what)),
    ...section("Expected", input.expected === undefined ? undefined : clean(input.expected)),
    ...section("Steps to reproduce", input.steps === undefined ? undefined : clean(input.steps)),
    ...section("Ruled out", input.ruledOut === undefined ? undefined : clean(input.ruledOut)),
    ...section("Device", deviceLines.join("\n")),
    ...section(
      "Versions and host",
      [
        `- ot-gateway: ${versionName(version)}${Option.isSome(newest) ? ` (newest release: ${newest.value})` : ""}`,
        `- Node: ${process.version}`,
        `- OS: ${osType()} ${release()} (${platform()}, ${arch()})`
      ].join("\n")
    ),
    ""
  ].join("\n")
  if (text.length > MAX_REPORT_LENGTH) return yield* tooLong(text.length)

  const existing = yield* github.searchIssues(`"${fingerprint}"`).pipe(
    Effect.catchTag("ReportFailed", (failure) =>
      Effect.sync(() => {
        warnings.push({
          about: "search",
          message: `${failure.message}. Look for the same report yourself before filing: ${ISSUES_URL}?q=${fingerprint}`
        })
        return [] as ReadonlyArray<IssueRef>
      })
    )
  )
  yield* fs.writeFileString(options.output, text).pipe(
    Effect.mapError(
      (failure) =>
        new ReportFailed({
          code: "report-draft-invalid",
          message: `could not write ${options.output}: ${failure.message}`,
          hint: "Name a file that can be written with --output"
        })
    )
  )
  // A comment goes to an issue that is still open; a closed one was fixed or declined, which the list says.
  const open = existing.find((issue) => issue.state === "open")
  return {
    path: options.output,
    title,
    text,
    fingerprint,
    replaced,
    existing,
    warnings,
    next: sendLine({ cli: options.cli, draft: options.output, config: options.config, to: open?.number })
  } satisfies ReportDraft
})

const tooLong = (length: number) =>
  new ReportFailed({
    code: "report-draft-invalid",
    message: `the report is ${length} characters, more than the ${MAX_REPORT_LENGTH} an issue takes here`,
    hint: "Keep the lines that show the failure and leave out the rest of the log; ot-gateway support writes the whole of it to a file the user can attach"
  })

const replacedLine = (replaced: Replaced) => {
  const parts = Object.entries(replaced).map(([kind, count]) => `${count} × ${kind}`)
  return parts.length === 0 ? "Nothing had to be replaced." : `Replaced by placeholders: ${parts.join(", ")}.`
}

/** What `report draft` prints: the text, what was replaced, what to settle first and the next command. */
export const formatDraft = (draft: ReportDraft) =>
  [
    draft.text.trimEnd(),
    "",
    "---",
    `wrote ${draft.path}. Nothing is filed yet.`,
    replacedLine(draft.replaced),
    ...draft.warnings.map((warning) => `! ${warning.message}${warning.next === undefined ? "" : ` (${warning.next})`}`),
    ...(draft.existing.length === 0
      ? []
      : [
          `Already reported (${plural(draft.existing.length, "issue")} with this fingerprint):`,
          ...draft.existing.map((issue) => `  #${issue.number} ${issue.title} (${issue.state}) ${issue.url}`)
        ]),
    `Show the user this text. When they agree: ${draft.next}`
  ].join("\n")

// ---------------------------------------------------------------------------------------------------------------
// send

export interface SendOptions {
  /** The draft's path. */
  readonly draft: string
  /** The config's path, for the names to replace; ot-gateway.json in this folder when none is named. */
  readonly config?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Add the report to this issue as a comment instead of opening one. */
  readonly to?: number | undefined
  /** The user has read the text and agreed to file it. */
  readonly yes: boolean
  /** A link to open instead of filing with `gh`. */
  readonly link: boolean
  readonly cli: string
  readonly machine?: { readonly hostname: string; readonly home: string }
}

export interface SendResult {
  /** Whether the report is on GitHub now. */
  readonly filed: boolean
  /** `gh`: with the user's GitHub CLI. `link`: the user opens the link and submits the form. */
  readonly method: "gh" | "link"
  /** Where it went or would go: `a new issue`, `a comment on #12`. */
  readonly target: string
  /** The GitHub account `gh` is signed in to, when it says. */
  readonly account?: string
  /** The issue or comment once filed, else the link to open. */
  readonly url?: string
  readonly path: string
  readonly title: string
  /** The text as filed: the draft after the same replacements as `draft` makes. */
  readonly text: string
  readonly replaced: Replaced
  readonly warnings: ReadonlyArray<DraftWarning>
  readonly note: string
  readonly next?: string
}

/** One shape for every way `send` ends, so a caller reads `url` and `next` without asking which it was. */
const sendResult = (result: SendResult) => result

/** The draft's title (its first line, a `# ` heading) and the issue's text after it. */
export const parseDraft = (text: string) => {
  const [first = "", ...rest] = text.trimStart().split("\n")
  const title = /^#\s+(.+)$/.exec(first.trim())?.[1]?.trim()
  const body = rest.join("\n").trim()
  return title === undefined || body === "" ? undefined : { title, body }
}

/** The form for a new issue, filled in; without the text when the link would be too long to open. */
export const issueLink = (title: string, body: string) => {
  const full = `${ISSUES_URL}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  return full.length <= MAX_LINK_LENGTH
    ? { url: full, withBody: true }
    : { url: `${ISSUES_URL}/new?title=${encodeURIComponent(title)}`, withBody: false }
}

const lastLineOf = (result: GhResult) =>
  (result.stderr.trim() === "" ? result.stdout : result.stderr)
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "") ?? `exit code ${result.exitCode}`

/**
 * Files the draft, or says how it would: with a signed-in `gh` and `yes` as an issue or a comment, otherwise as a
 * link. The draft is cleaned once more and written back, so the file is the text that was filed.
 */
export const sendReport = Effect.fn("sendReport")(function* (options: SendOptions) {
  const fs = yield* FileSystem.FileSystem
  const github = yield* GitHub
  const raw = yield* fs.readFileString(options.draft).pipe(
    Effect.mapError(
      (failure) =>
        new ReportFailed({
          code: "report-draft-invalid",
          message: `could not read the draft ${options.draft}: ${failure.message}`,
          hint: "Write one first",
          next: `${options.cli} report draft --help`
        })
    )
  )
  const path = options.config ?? defaultConfigPath
  const site = yield* readSite(path, options.env ?? process.env, options.machine)
  const cleaned = publicText(raw, site.options)
  const draft = parseDraft(cleaned.text)
  if (draft === undefined || fingerprintIn(cleaned.text) === undefined) {
    return yield* new ReportFailed({
      code: "report-draft-invalid",
      message: `${options.draft} is not a draft of report draft: it needs a first line "# <title>", the fingerprint line and a text`,
      hint: "Write the draft with report draft and edit that file",
      next: `${options.cli} report draft --help`
    })
  }
  if (cleaned.text.length > MAX_REPORT_LENGTH) return yield* tooLong(cleaned.text.length)
  if (cleaned.text !== raw) {
    // The file stays the text that is filed: a draft that cannot be written back is not sent.
    yield* fs.writeFileString(options.draft, cleaned.text).pipe(
      Effect.mapError(
        (failure) =>
          new ReportFailed({
            code: "report-draft-invalid",
            message: `could not write the cleaned draft back to ${options.draft}: ${failure.message}`,
            hint: "Make the file writable, or copy it to a folder that is"
          })
      )
    )
  }
  const warnings = site.config === undefined ? [noConfigWarning(path)] : []
  const target = options.to === undefined ? "a new issue" : `a comment on #${options.to}`
  const common = {
    target,
    path: options.draft,
    title: draft.title,
    text: cleaned.text,
    replaced: cleaned.replaced,
    warnings
  }

  const status = options.link
    ? Option.none<GhResult>()
    : yield* github
        .gh(["auth", "status", "--hostname", "github.com"])
        // A gh that does not answer whether it is signed in is not one to file with.
        .pipe(Effect.catchTag("GhTimedOut", () => Effect.succeedNone))
  const signedIn = Option.isSome(status) && status.value.exitCode === 0
  if (!signedIn) {
    const link =
      options.to === undefined
        ? issueLink(draft.title, draft.body)
        : { url: `${ISSUES_URL}/${options.to}`, withBody: false }
    return sendResult({
      ...common,
      filed: false,
      method: "link",
      url: link.url,
      note: `${
        options.link ? "" : "No GitHub CLI (gh) signed in on this machine. "
      }Open the link in a browser signed in to GitHub${
        link.withBody ? " and submit the form" : `, paste the text of ${options.draft} and submit`
      }. Without a GitHub account, pass ${options.draft} on to whoever supports this gateway.`
    })
  }
  const said = `${status.value.stdout}\n${status.value.stderr}`
  const account = /account\s+(\S+)/.exec(said)?.[1] ?? /Logged in to \S+ as (\S+)/.exec(said)?.[1]
  const who = account === undefined ? {} : { account }
  if (!options.yes) {
    return sendResult({
      ...common,
      ...who,
      filed: false,
      method: "gh",
      note: `Not filed. With --yes this text becomes ${target} on github.com/${REPORT_REPOSITORY}, public${
        account === undefined ? "" : `, under the GitHub account ${account}`
      }. Add --yes only after the user has read it and agreed.`,
      next: sendLine({ ...options, flag: "--yes" })
    })
  }
  const args =
    options.to === undefined
      ? ["issue", "create", "--repo", REPORT_REPOSITORY, "--title", draft.title, "--body", draft.body]
      : [
          "issue",
          "comment",
          String(options.to),
          "--repo",
          REPORT_REPOSITORY,
          "--body",
          `**${draft.title}**\n\n${draft.body}`
        ]
  const result = yield* github.gh(args).pipe(
    Effect.catchTag("GhTimedOut", (timeout) =>
      Effect.fail(
        new ReportFailed({
          code: "report-unconfirmed",
          message: `${timeout.message}: the report may or may not be on GitHub`,
          hint: `Look for it before sending again, so it is not filed twice: ${
            options.to === undefined
              ? `${ISSUES_URL}?q=${fingerprintIn(cleaned.text) ?? ""}`
              : `${ISSUES_URL}/${options.to}`
          }`
        })
      )
    )
  )
  if (Option.isNone(result) || result.value.exitCode !== 0) {
    return yield* new ReportFailed({
      code: "report-not-filed",
      message: `gh did not file the report: ${Option.isNone(result) ? "it could not be started" : lastLineOf(result.value)}`,
      hint: "Open the form in a browser instead",
      next: sendLine({ ...options, flag: "--link" })
    })
  }
  const url = /https:\/\/github\.com\/\S+/.exec(result.value.stdout)?.[0]
  return sendResult({
    ...common,
    ...who,
    ...(url === undefined ? {} : { url }),
    filed: true,
    method: "gh",
    note: `Filed as ${target}${url === undefined ? "" : `: ${url}`}`
  })
})

/** What `report send` prints: the text when it is not filed yet, and what happened or what to do. */
export const formatSend = (result: SendResult) =>
  [
    ...(result.filed ? [] : [result.text.trimEnd(), "", "---"]),
    ...(Object.keys(result.replaced).length === 0 ? [] : [replacedLine(result.replaced)]),
    ...result.warnings.map((warning) => `! ${warning.message}`),
    result.note,
    ...(result.method === "link" && result.url !== undefined ? [result.url] : []),
    ...(result.next === undefined ? [] : [result.next])
  ].join("\n")
