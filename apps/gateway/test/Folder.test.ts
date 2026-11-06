/**
 * The gateway's folder: `init` writes compose.yaml and ot-gateway.env next to ot-gateway.json, never replaces
 * either, and the CLI reads ot-gateway.env without overriding what the environment already sets.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { Effect, FileSystem } from "effect"
import { join } from "node:path"
import { loadEnvFile, missingFromEnv } from "../src/EnvFile.ts"
import { composeTemplatePath, envFileText, writeFolderFiles } from "../src/Folder.ts"
import { initConfig, nextSteps } from "../src/Init.ts"

const answers = { site: "vienna-hq", building: "main", brokerUrl: "mqtt://broker.lan:1883" }
const withLogin = { ...answers, login: { username: "gateway", passwordEnv: "MQTT_PASSWORD" } }
const config = (input: Parameters<typeof initConfig>[0]) => parseConfig(JSON.stringify(initConfig(input, [])))

describe("writeFolderFiles", () => {
  it.effect("writes compose.yaml and an owner-only ot-gateway.env with the password variable empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const files = yield* writeFolderFiles(join(folder, "ot-gateway.json"), yield* config(withLogin))
      expect(files.written).toEqual([join(folder, "compose.yaml"), join(folder, "ot-gateway.env")])
      expect(yield* fs.readFileString(join(folder, "compose.yaml"))).toBe(yield* fs.readFileString(composeTemplatePath))
      expect(yield* fs.readFileString(join(folder, "ot-gateway.env"))).toBe(envFileText("MQTT_PASSWORD"))
      expect((yield* fs.stat(join(folder, "ot-gateway.env"))).mode & 0o777).toBe(0o600)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps files that are there and writes no env file without a broker login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(join(folder, "compose.yaml"), "# edited\n")
      const files = yield* writeFolderFiles(join(folder, "ot-gateway.json"), yield* config(answers))
      expect(files).toEqual({ written: [], kept: [join(folder, "compose.yaml")], noCompose: undefined })
      expect(yield* fs.readFileString(join(folder, "compose.yaml"))).toBe("# edited\n")
      expect(yield* fs.exists(join(folder, "ot-gateway.env"))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("writes no compose.yaml for a config under another name, which compose.yaml would not mount", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const files = yield* writeFolderFiles(join(folder, "site.json"), yield* config(withLogin))
      expect(files.written).toEqual([join(folder, "ot-gateway.env")])
      expect(files.noCompose).toContain("site.json")
      expect(yield* fs.exists(join(folder, "compose.yaml"))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("nextSteps with a folder", () => {
  it.effect("leads with docker compose and points at the env file for the password", () =>
    Effect.gen(function* () {
      const steps = nextSteps("ot-gateway.json", yield* config(withLogin), {
        written: ["ot-gateway.json", "compose.yaml", "ot-gateway.env"],
        kept: []
      })
      expect(steps).toContain("wrote compose.yaml")
      expect(steps).toContain("put the broker password after MQTT_PASSWORD= in ot-gateway.env")
      expect(steps.indexOf("docker compose up -d")).toBeLessThan(steps.indexOf("ot-gateway check"))
      expect(steps).not.toContain("ot-gateway run")
    })
  )
})

describe("the env file", () => {
  it("adds only variables that are unset and not empty", () => {
    const text = "# comment\nMQTT_PASSWORD=secret\nOTEL_SERVICE_NAME=gw\nEMPTY=\n"
    expect(missingFromEnv(text, { OTEL_SERVICE_NAME: "from-shell" })).toEqual([["MQTT_PASSWORD", "secret"]])
  })

  it.effect("loads a file into the given environment and ignores a missing one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const file = join(folder, "ot-gateway.env")
      yield* fs.writeFileString(file, "MQTT_PASSWORD=secret\n")
      const env: Record<string, string | undefined> = {}
      loadEnvFile(join(folder, "absent.env"), env)
      expect(env).toEqual({})
      loadEnvFile(file, env)
      expect(env).toEqual({ MQTT_PASSWORD: "secret" })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
