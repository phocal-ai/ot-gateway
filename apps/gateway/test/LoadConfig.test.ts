/**
 * Loading the config file: what a first-time user sees when the file is missing or wrong.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
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
      expect(error.message).toContain("examples/gateway.json")
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("lists every mistake of an invalid config in one message, each with its path", () =>
    Effect.gen(function* () {
      const path = yield* configFile(
        JSON.stringify({
          site: "Vienna HQ",
          building: "b1",
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
})
