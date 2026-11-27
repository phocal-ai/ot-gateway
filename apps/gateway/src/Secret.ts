/**
 * `ot-gateway secret set|list`: what does not belong in `ot-gateway.json` (the broker password, the status page's
 * edit token) put into `ot-gateway.env` next to the config, the file Docker Compose and the CLI read.
 *
 * A value is never an argument (it would stay in the shell's history and show in the process list), never printed
 * and never in a result: `set` asks for it without echo in a terminal and reads it from stdin otherwise, or makes a
 * random one (`--generate`). So an agent can say what is missing (`list`, by name only) and hand the person the one
 * command to run, without the secret passing through the conversation. The file is written whole through a
 * temporary one and is the owner's alone (0600).
 */
import type { GatewayConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Path, Schema } from "effect"
import { randomBytes } from "node:crypto"
import { parseEnv } from "node:util"
import { EDIT_TOKEN_VARIABLE, isLoopbackAddress } from "./EditGuard.ts"
import { envFileName } from "./EnvFile.ts"
import { defaultConfigPath } from "./Import.ts"
import { loadConfig } from "./LoadConfig.ts"
import { shellArgument } from "./Output.ts"

/** Why a secret was not set; the file is as it was. */
export class SecretFailed extends Schema.TaggedError<SecretFailed>()("SecretFailed", {
  message: Schema.String,
  code: Schema.String,
  hint: Schema.optionalKey(Schema.String)
}) {}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The variable a secret's name stands for: `broker-password` is the one the config's `mqtt.passwordEnv` names,
 * `edit-token` the status page's, and a variable's own name is itself.
 */
export const secretVariable = (name: string, config: GatewayConfig, cli = "ot-gateway"): string | SecretFailed => {
  if (name === "broker-password") {
    return (
      config.mqtt.passwordEnv ??
      new SecretFailed({
        message:
          "the config names no variable for the broker password (mqtt.passwordEnv), so the gateway would not read one",
        code: "no-password-variable",
        hint: `${cli} config set mqtt.username <username>, then ${cli} config set mqtt.passwordEnv MQTT_PASSWORD, then this again`
      })
    )
  }
  if (name === "edit-token") return EDIT_TOKEN_VARIABLE
  return VARIABLE.test(name)
    ? name
    : new SecretFailed({
        message: `${name} is not broker-password, edit-token or a variable's name (letters, digits and _)`,
        code: "usage",
        hint: `${cli} secret set broker-password`
      })
}

/** What needs no quotes in an env file, for Docker Compose, systemd and Node alike. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]*$/

/**
 * A value as an env file's line holds it: as it is when it is plain, in single quotes otherwise, where Docker
 * Compose, systemd and Node all take every character as itself (`$` too). A single quote or a line break has no
 * spelling all three agree on, so such a value is refused.
 */
export const envValue = (value: string): string | SecretFailed => {
  if (PLAIN.test(value)) return value
  return /['\r\n]/.test(value)
    ? new SecretFailed({
        message:
          "a value with a single quote or a line break cannot be written so that Docker Compose, systemd and the CLI all read it the same",
        code: "secret-not-writable",
        hint: "use a secret without them, or write the line into ot-gateway.env by hand in the form your setup reads"
      })
    : `'${value}'`
}

/**
 * The env file's text with `name` set: its line replaced where there is one (the empty one `init` writes, or a
 * commented-out `# NAME=`), a new line at the end otherwise. Every other line stays.
 */
export const envFileWith = (text: string, name: string, written: string) => {
  const lines = text.split("\n")
  const own = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
  const commented = new RegExp(`^\\s*#\\s*${name}\\s*=`)
  const at = lines.findIndex((line) => own.test(line))
  const line = `${name}=${written}`
  if (at >= 0) {
    // One line per variable: a second one further down would win or lose depending on who reads the file.
    return lines
      .filter((each, index) => index === at || !own.test(each))
      .map((each) => (own.test(each) ? line : each))
      .join("\n")
  }
  const hint = lines.findIndex((each) => commented.test(each))
  if (hint >= 0) return lines.map((each, index) => (index === hint ? line : each)).join("\n")
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`
  return `${body}${line}\n`
}

/** Where the env file of the config at `configPath` is. */
export const envFileOf = Effect.fn("envFileOf")(function* (configPath: string) {
  const paths = yield* Path.Path
  return paths.join(paths.dirname(configPath), envFileName)
})

export interface SecretSetReport {
  readonly ok: true
  /** The name as asked: broker-password, edit-token or a variable. */
  readonly secret: string
  readonly variable: string
  readonly file: string
  /** Whether the file had a value for it before. */
  readonly replaced: boolean
  readonly generated: boolean
  readonly next: ReadonlyArray<{ readonly command: string; readonly description: string }>
}

/**
 * Sets the secret `name` of the config at `configPath` to `value` in the folder's env file. The value is in no
 * result and no message.
 */
export const setSecret = Effect.fn("setSecret")(function* (
  configPath: string,
  name: string,
  value: { readonly value: string } | { readonly generate: true },
  options: { readonly command?: string | undefined } = {}
) {
  const fs = yield* FileSystem.FileSystem
  const cli = options.command ?? "ot-gateway"
  const config = yield* loadConfig(configPath)
  const variable = secretVariable(name, config, cli)
  if (variable instanceof SecretFailed) return yield* variable
  const secret = "generate" in value ? randomBytes(32).toString("hex") : value.value
  if (secret === "") {
    return yield* new SecretFailed({
      message: `no value for ${variable}: nothing was written`,
      code: "secret-empty",
      hint: `the person who has it runs ${cli} secret set ${name} in a terminal and types it there (an agent does not ask for it), or a script pipes it in: printf %s "$VALUE" | ${cli} secret set ${name}`
    })
  }
  const written = envValue(secret)
  if (written instanceof SecretFailed) return yield* written
  const file = yield* envFileOf(configPath)
  const notWritten = (what: string) => (error: { readonly message: string }) =>
    new SecretFailed({
      message: `could not ${what} ${file}: ${error.message}`,
      code: "secret-not-writable",
      hint: `the user running this must be able to write ${file} and its folder`
    })
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
    Effect.mapError(notWritten("read"))
  )
  const replaced = (parseEnv(text)[variable] ?? "") !== ""
  const temporary = `${file}.tmp`
  // Written beside it, the owner's alone from the first byte, then moved over it: never half a file of secrets.
  yield* Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 })
        yield* handle.writeAll(new TextEncoder().encode(envFileWith(text, variable, written)))
        yield* handle.sync
      })
    )
    yield* fs.chmod(temporary, 0o600)
    yield* fs.rename(temporary, file)
  }).pipe(
    Effect.mapError(notWritten("write")),
    Effect.tapError(() => Effect.ignore(fs.remove(temporary)))
  )
  const at = configPath === defaultConfigPath ? "" : ` ${shellArgument(configPath)}`
  return {
    ok: true,
    secret: name,
    variable,
    file,
    replaced,
    generated: "generate" in value,
    next: [
      ...(variable === config.mqtt.passwordEnv
        ? [
            {
              command: `${cli} broker${at}`,
              description: "Connect to the broker with it, and a message there and back"
            }
          ]
        : []),
      {
        command: `${cli} restart${at}`,
        description: "The running gateway reads ot-gateway.env again; under systemd, restart its service"
      }
    ]
  } satisfies SecretSetReport
})

export interface SecretStatus {
  /** The name `secret set` takes for it, or the variable itself. */
  readonly secret: string
  readonly variable: string
  readonly what: string
  /** Whether the gateway needs it as the config is. */
  readonly needed: boolean
  /** Whether the file (or this environment) has a value for it. Never the value. */
  readonly set: boolean
}

/** The secrets the config can use, each with whether it is needed and set, by name only. */
export const secretStatuses = (
  config: GatewayConfig,
  fileText: string,
  env: Readonly<Record<string, string | undefined>>
): ReadonlyArray<SecretStatus> => {
  const file = parseEnv(fileText)
  const isSet = (variable: string) => (file[variable] ?? "") !== "" || (env[variable] ?? "") !== ""
  const passwordEnv = config.mqtt.passwordEnv
  const lan = config.status !== undefined && !isLoopbackAddress(config.status.bindAddress)
  const known = [
    ...(passwordEnv === undefined
      ? []
      : [{ secret: "broker-password", variable: passwordEnv, what: "the MQTT broker password", needed: true }]),
    {
      secret: "edit-token",
      variable: EDIT_TOKEN_VARIABLE,
      what: "lets the status page save the config when it is reached over the network",
      needed: lan
    }
  ]
  const others = Object.keys(file)
    .filter((variable) => known.every((each) => each.variable !== variable))
    .map((variable) => ({ secret: variable, variable, what: "set in the file", needed: false }))
  return [...known, ...others].map((each) => ({ ...each, set: isSet(each.variable) }))
}

export interface SecretListReport {
  readonly ok: true
  readonly path: string
  readonly file: string
  readonly secrets: ReadonlyArray<SecretStatus>
  /** The ones the gateway needs and does not have. */
  readonly missing: ReadonlyArray<string>
  readonly next: ReadonlyArray<{ readonly command: string; readonly description: string }>
}

/** Which secrets the config at `configPath` needs and which its env file has, by name only. */
export const listSecrets = Effect.fn("listSecrets")(function* (
  configPath: string,
  options: { readonly command?: string | undefined } = {}
) {
  const fs = yield* FileSystem.FileSystem
  const cli = options.command ?? "ot-gateway"
  const config = yield* loadConfig(configPath)
  const file = yield* envFileOf(configPath)
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
    Effect.mapError(
      (error) =>
        new SecretFailed({
          message: `could not read ${file}: ${error.message}`,
          code: "secret-not-writable",
          hint: `the user running this must be able to read ${file}`
        })
    )
  )
  const secrets = secretStatuses(config, text, process.env)
  const missing = secrets.filter((each) => each.needed && !each.set)
  const at = configPath === defaultConfigPath ? "" : ` --config=${shellArgument(configPath)}`
  return {
    ok: true,
    path: configPath,
    file,
    secrets,
    missing: missing.map((each) => each.secret),
    next: missing.map((each) => ({
      command: `${cli} secret set ${each.secret}${at}`,
      description: `For the person to run in a terminal: it asks for ${each.what} without showing it`
    }))
  } satisfies SecretListReport
})

export const formatSecretSet = (report: SecretSetReport) =>
  [
    `✓ ${report.variable} ${report.generated ? "is a new random value" : report.replaced ? "has its new value" : "is set"} in ${report.file} (yours alone, never printed)`,
    ...(report.generated ? [`  read it there when the status page asks for it`] : []),
    ...report.next.map((step) => `  next: ${step.command}   # ${step.description}`)
  ].join("\n")

export const formatSecretList = (report: SecretListReport) =>
  [
    ...report.secrets.map(
      (each) =>
        `${each.set ? "✓" : each.needed ? "✗" : "–"} ${each.secret.padEnd(16)} ${each.variable}: ${each.set ? "set" : each.needed ? "not set, and the gateway needs it" : "not set"} (${each.what})`
    ),
    ...report.next.map((step) => `  next: ${step.command}`)
  ].join("\n")
