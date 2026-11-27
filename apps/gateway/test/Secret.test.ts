/**
 * `secret set|list`: a secret goes into `ot-gateway.env` next to the config, in a spelling Docker Compose, systemd
 * and the CLI all read the same, into a file that is the owner's alone, and no result or message holds its value.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem, type Scope } from "effect"
import { statSync } from "node:fs"
import { parseEnv } from "node:util"
import {
  envFileWith,
  envValue,
  formatSecretList,
  formatSecretSet,
  listSecrets,
  secretStatuses,
  secretVariable,
  setSecret
} from "../src/Secret.ts"

const config = (extra: Readonly<Record<string, unknown>> = {}) => ({
  site: "s",
  building: "b",
  mqtt: { url: "mqtts://broker.example:8883", username: "gw", passwordEnv: "MQTT_PASSWORD" },
  devices: [],
  ...extra
})

const folder = (configValue: unknown = config(), env?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const path = `${directory}/ot-gateway.json`
    yield* fs.writeFileString(path, JSON.stringify(configValue))
    if (env !== undefined) yield* fs.writeFileString(`${directory}/ot-gateway.env`, env, { mode: 0o644 })
    return { fs, path, envFile: `${directory}/ot-gateway.env` }
  })

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("env file lines", () => {
  it("writes a plain value as it is, anything else in single quotes, and refuses what has no one spelling", () => {
    expect(envValue("s3cret-token_1")).toBe("s3cret-token_1")
    expect(envValue("p@ss w$rd #1")).toBe("'p@ss w$rd #1'")
    expect(parseEnv(`X=${String(envValue('a "b" $HOME \\n'))}`)).toEqual({ X: 'a "b" $HOME \\n' })
    expect(envValue("it's")).toMatchObject({ code: "secret-not-writable" })
    expect(envValue("two\nlines")).toMatchObject({ code: "secret-not-writable" })
  })

  it("replaces the variable's line, an empty or commented-out one too, and adds one otherwise", () => {
    const text = "# The MQTT broker password.\nMQTT_PASSWORD=\n\n# OTEL_X=1\nTZ=Europe/Vienna\n"
    expect(envFileWith(text, "MQTT_PASSWORD", "pw")).toBe(
      "# The MQTT broker password.\nMQTT_PASSWORD=pw\n\n# OTEL_X=1\nTZ=Europe/Vienna\n"
    )
    expect(envFileWith(text, "OTEL_X", "2")).toBe(
      "# The MQTT broker password.\nMQTT_PASSWORD=\n\nOTEL_X=2\nTZ=Europe/Vienna\n"
    )
    expect(envFileWith(text, "NEW", "v")).toBe(`${text}NEW=v\n`)
    expect(envFileWith("A=1", "B", "2")).toBe("A=1\nB=2\n")
    expect(envFileWith("", "B", "2")).toBe("B=2\n")
    // One line per variable, whoever reads the file.
    expect(envFileWith("A=1\nB=x\nA=2\n", "A", "3")).toBe("A=3\nB=x\n")
    // Another variable that only starts the same is left alone.
    expect(envFileWith("MQTT_PASSWORD_OLD=1\n", "MQTT_PASSWORD", "pw")).toBe("MQTT_PASSWORD_OLD=1\nMQTT_PASSWORD=pw\n")
  })
})

describe("secret names", () => {
  it.effect("stand for the config's password variable, the edit token, or a variable itself", () =>
    Effect.gen(function* () {
      const withLogin = yield* parseConfig(JSON.stringify(config()))
      expect(secretVariable("broker-password", withLogin)).toBe("MQTT_PASSWORD")
      expect(secretVariable("edit-token", withLogin)).toBe("OT_GATEWAY_EDIT_TOKEN")
      expect(secretVariable("OTEL_EXPORTER_OTLP_HEADERS", withLogin)).toBe("OTEL_EXPORTER_OTLP_HEADERS")
      expect(secretVariable("not a name", withLogin)).toMatchObject({ code: "usage" })
      const open = yield* parseConfig(JSON.stringify(config({ mqtt: { url: "mqtt://localhost:1883" } })))
      expect(secretVariable("broker-password", open, "otg")).toMatchObject({
        code: "no-password-variable",
        hint: expect.stringContaining("otg config set mqtt.passwordEnv MQTT_PASSWORD")
      })
    })
  )

  it.effect("are needed as the config is: the password with a login, the token with a page on the network", () =>
    Effect.gen(function* () {
      const local = yield* parseConfig(JSON.stringify(config({ status: {} })))
      expect(secretStatuses(local, "MQTT_PASSWORD=\nTZ=UTC\n", {})).toEqual([
        {
          secret: "broker-password",
          variable: "MQTT_PASSWORD",
          what: "the MQTT broker password",
          needed: true,
          set: false
        },
        expect.objectContaining({ secret: "edit-token", needed: false, set: false }),
        expect.objectContaining({ secret: "TZ", variable: "TZ", needed: false, set: true })
      ])
      const lan = yield* parseConfig(JSON.stringify(config({ status: { bindAddress: "0.0.0.0" } })))
      const statuses = secretStatuses(lan, "", { MQTT_PASSWORD: "from the shell" })
      expect(statuses.map((each) => [each.secret, each.needed, each.set])).toEqual([
        ["broker-password", true, true],
        ["edit-token", true, false]
      ])
    })
  )
})

describe("secret set", () => {
  it.effect("writes the value into the folder's env file, the owner's alone, and never says it", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, envFile } = yield* folder(config(), "# mine\nMQTT_PASSWORD=\n")
        const report = yield* setSecret(path, "broker-password", { value: "p@ss w$rd" })
        expect(report).toMatchObject({
          ok: true,
          secret: "broker-password",
          variable: "MQTT_PASSWORD",
          file: envFile,
          replaced: false,
          generated: false
        })
        expect(report.next.map((step) => step.command)).toEqual([
          `ot-gateway broker ${path}`,
          `ot-gateway restart ${path}`
        ])
        expect(JSON.stringify(report)).not.toContain("p@ss")
        expect(formatSecretSet(report)).not.toContain("p@ss")
        expect(yield* fs.readFileString(envFile)).toBe("# mine\nMQTT_PASSWORD='p@ss w$rd'\n")
        // A file others could read is closed with the write.
        expect(statSync(envFile).mode & 0o777).toBe(0o600)
        expect(yield* fs.exists(`${envFile}.tmp`)).toBe(false)
        const again = yield* setSecret(path, "broker-password", { value: "second" })
        expect(again.replaced).toBe(true)
        expect(parseEnv(yield* fs.readFileString(envFile))).toEqual({ MQTT_PASSWORD: "second" })
      })
    )
  )

  it.effect("makes the file when there is none, and a random token on request", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, envFile } = yield* folder()
        const report = yield* setSecret(path, "edit-token", { generate: true })
        expect(report).toMatchObject({ variable: "OT_GATEWAY_EDIT_TOKEN", generated: true, replaced: false })
        const token = parseEnv(yield* fs.readFileString(envFile))["OT_GATEWAY_EDIT_TOKEN"] ?? ""
        expect(token).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.stringify(report)).not.toContain(token)
        expect(statSync(envFile).mode & 0o777).toBe(0o600)
      })
    )
  )

  it.effect("refuses no value, a value no env file can hold, and a password the config would not read", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, envFile } = yield* folder(config(), "MQTT_PASSWORD=keep\n")
        expect(yield* Effect.flip(setSecret(path, "broker-password", { value: "" }))).toMatchObject({
          _tag: "SecretFailed",
          code: "secret-empty"
        })
        const quote = yield* Effect.flip(setSecret(path, "broker-password", { value: "it's" }))
        expect(quote).toMatchObject({ code: "secret-not-writable" })
        expect(quote.message).not.toContain("it's")
        expect(yield* fs.readFileString(envFile)).toBe("MQTT_PASSWORD=keep\n")
        const open = yield* folder(config({ mqtt: { url: "mqtt://localhost:1883" } }))
        expect(yield* Effect.flip(setSecret(open.path, "broker-password", { value: "x" }))).toMatchObject({
          code: "no-password-variable"
        })
        expect(yield* fs.exists(open.envFile)).toBe(false)
      })
    )
  )
})

describe("secret list", () => {
  it.effect("names what is needed and missing, and the command the person runs", () =>
    run(
      Effect.gen(function* () {
        const { path } = yield* folder(config(), "MQTT_PASSWORD=\n")
        // The shell this test runs in may set it.
        const before = process.env["MQTT_PASSWORD"]
        delete process.env["MQTT_PASSWORD"]
        const report = yield* listSecrets(path, { command: "otg" }).pipe(
          Effect.ensuring(
            Effect.sync(() => (before === undefined ? undefined : (process.env["MQTT_PASSWORD"] = before)))
          )
        )
        expect(report).toMatchObject({ ok: true, missing: ["broker-password"] })
        expect(report.next.map((step) => step.command)).toEqual([`otg secret set broker-password --config=${path}`])
        expect(formatSecretList(report)).toContain("✗ broker-password")
        yield* setSecret(path, "broker-password", { value: "pw" })
        const after = yield* listSecrets(path)
        expect(after).toMatchObject({ missing: [], next: [] })
        expect(JSON.stringify(after)).not.toContain('"pw"')
      })
    )
  )
})
