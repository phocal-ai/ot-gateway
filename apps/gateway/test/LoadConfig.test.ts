/**
 * Loading the config file: what a first-time user sees when the file is missing or wrong.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem } from "effect"
import { dirname, resolve } from "node:path"
import { loadConfig } from "../src/LoadConfig.ts"

/** Writes `text` into a temporary directory and returns its path. */
const configFile = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ot-gateway-config-" })
    yield* fs.writeFileString(`${root}/gateway.json`, text)
    return `${root}/gateway.json`
  })

describe("loadConfig", () => {
  it.effect("says how to get a config when the file is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadConfig("does-not-exist/ot-gateway.json"))
      expect(error._tag).toBe("ConfigFileError")
      expect(error.message).toContain("no config at does-not-exist/ot-gateway.json")
      expect(error.message).toContain("run ot-gateway init")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("lists every mistake of an invalid config in one message, each with its path", () =>
    Effect.gen(function* () {
      const path = yield* configFile(
        JSON.stringify({
          site: "Site 1",
          building: "building-a",
          mqtt: { url: "mqtt://localhost:1883" },
          devices: [
            {
              protocol: "modbus-tcp",
              id: "meter",
              host: "192.168.1.50",
              pollIntervall: 5000,
              points: [{ id: "power", name: "Power", table: "holding", address: 0, dataType: "float" }]
            }
          ]
        })
      )
      const error = yield* Effect.flip(loadConfig(path))
      expect(error.message).toContain(`${path} is not a valid config`)
      expect(error.message).toContain(`at ["site"]`)
      expect(error.message).toContain(`at ["devices"][0]["pollIntervall"]`)
      expect(error.message).toContain(`at ["devices"][0]["points"][0]["dataType"]`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("names the file in a JSON syntax error", () =>
    Effect.gen(function* () {
      const path = yield* configFile(`{ "site": "a", }`)
      const error = yield* Effect.flip(loadConfig(path))
      expect(error.message).toContain(`${path} is not a valid config:\ninvalid JSON`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("returns the decoded config when it is valid", () =>
    Effect.gen(function* () {
      const config = yield* loadConfig("../../examples/gateway.json")
      expect(config.site).toBe("demo-site")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  for (const file of ["gateway.json", "building.json", "industrial.json"]) {
    it.effect(`loads the example ${file}`, () =>
      Effect.gen(function* () {
        const config = yield* loadConfig(`../../examples/${file}`)
        expect(config.devices.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  }
})

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))

const withFiles = JSON.stringify({
  site: "site-1",
  building: "main",
  mqtt: { url: "mqtt://localhost:1883" },
  buffer: { path: "./ot-gateway-buffer.sqlite" },
  history: { path: "data/history.sqlite" },
  devices: []
})

describe("loadConfig's file paths", () => {
  it.effect("resolves relative ones against the config's folder, not the working directory", () =>
    Effect.gen(function* () {
      const path = yield* configFile(withFiles)
      const config = yield* loadConfig(path).pipe(withEnv({}))
      expect(config.buffer?.path).toBe(`${dirname(path)}/ot-gateway-buffer.sqlite`)
      expect(config.history?.path).toBe(`${dirname(path)}/data/history.sqlite`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("resolves them against OT_GATEWAY_DATA_DIR when set, as the container image does for Compose", () =>
    Effect.gen(function* () {
      const path = yield* configFile(withFiles)
      const config = yield* loadConfig(path).pipe(withEnv({ OT_GATEWAY_DATA_DIR: "/var/lib/ot-gateway" }))
      expect(config.buffer?.path).toBe("/var/lib/ot-gateway/ot-gateway-buffer.sqlite")
      expect(config.history?.path).toBe("/var/lib/ot-gateway/data/history.sqlite")
      // Empty, as the Docker wrapper passes it, means the config's folder again.
      const unset = yield* loadConfig(path).pipe(withEnv({ OT_GATEWAY_DATA_DIR: "" }))
      expect(unset.buffer?.path).toBe(`${dirname(path)}/ot-gateway-buffer.sqlite`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("reads ot-gateway.env next to a config in another folder, so the broker password is found there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* configFile(withFiles)
      const name = "OT_GATEWAY_LOAD_CONFIG_TEST"
      yield* fs.writeFileString(`${dirname(path)}/ot-gateway.env`, `${name}=from-the-folder\n`)
      yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env[name]))
      yield* loadConfig(path).pipe(withEnv({}))
      expect(process.env[name]).toBe("from-the-folder")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("keeps absolute paths as they are", () =>
    Effect.gen(function* () {
      const config = yield* loadConfig("../../examples/building.json").pipe(withEnv({ OT_GATEWAY_DATA_DIR: "/data" }))
      expect(config.buffer?.path).toBe("/var/lib/ot-gateway/buffer.sqlite")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("resolves a relative config path the same way", () =>
    Effect.gen(function* () {
      const config = yield* loadConfig("../../examples/gateway.json").pipe(withEnv({}))
      expect(config.buffer?.path).toBe(resolve("../../examples/ot-gateway-buffer.sqlite"))
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
