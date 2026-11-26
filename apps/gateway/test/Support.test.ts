import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { join } from "node:path"
import {
  formatSupportSummary,
  REDACTED,
  redactJson,
  redactText,
  secretsOf,
  settingNames,
  supportBundle,
  supportFileName
} from "../src/Support.ts"

describe("redaction", () => {
  it("redacts keys that hold a secret, not the ones that name where it is", () => {
    expect(
      redactJson({ mqtt: { url: "mqtt://broker", passwordEnv: "MQTT_PASSWORD", password: "hunter22" }, token: 1 })
    ).toEqual({ mqtt: { url: "mqtt://broker", passwordEnv: "MQTT_PASSWORD", password: REDACTED }, token: REDACTED })
  })

  it("redacts credentials in a URL and each secret, the longest first", () => {
    expect(redactText("mqtts://user:pass@broker:8883 and hunter22 and hunter2245", ["hunter22", "hunter2245"])).toBe(
      `mqtts://${REDACTED}@broker:8883 and ${REDACTED} and ${REDACTED}`
    )
    // Too short to replace without mangling the text.
    expect(redactText("a 1 b", ["1"])).toBe("a 1 b")
  })

  it("takes the secrets from the env file, the password variable, the edit token and the OTLP headers", () => {
    const env = {
      SITE_PASSWORD: "broker-secret",
      OT_GATEWAY_EDIT_TOKEN: "edit-secret",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic abcd1234"
    }
    expect(secretsOf(env, "OTHER=from-file\nEMPTY=\n", "SITE_PASSWORD").toSorted()).toEqual(
      ["from-file", "broker-secret", "edit-secret", "Authorization=Basic abcd1234", "Basic abcd1234"].toSorted()
    )
    expect(settingNames({ ...env, PATH: "/bin", OT_GATEWAY_DATA_DIR: "/data" })).toEqual([
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OT_GATEWAY_DATA_DIR",
      "OT_GATEWAY_EDIT_TOKEN"
    ])
  })
})

const config = {
  site: "plant-1",
  building: "hall-a",
  mqtt: { url: "mqtt://127.0.0.1:1883", passwordEnv: "SUPPORT_TEST_PASSWORD" },
  // Port 1 on loopback: nothing listens there, so the gateway sections say why they are empty.
  status: { port: 1 },
  devices: [
    {
      protocol: "simulator",
      id: "room",
      points: [{ id: "temperature", name: "Temperature", waveform: "constant", min: 21, max: 21 }]
    }
  ]
}

describe("supportBundle", () => {
  it.effect("writes every section, says why the gateway's are empty, and leaves no secret in it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const path = join(folder, "ot-gateway.json")
      yield* fs.writeFileString(path, JSON.stringify(config))
      yield* fs.writeFileString(join(folder, "ot-gateway.env"), "SUPPORT_TEST_PASSWORD=s3cret-pw\n")
      const env = { SUPPORT_TEST_PASSWORD: "s3cret-pw", OT_GATEWAY_EDIT_TOKEN: "t0ken-value" }
      const bundle = yield* supportBundle({ config: path, env, now: Date.UTC(2026, 10, 26, 17, 8, 9) })
      expect(bundle.sections.map((section) => [section.name, section.ok])).toEqual([
        ["host", true],
        ["config", true],
        ["environment", true],
        ["status", false],
        ["events", false],
        ["logs", false]
      ])
      expect(bundle.text).toContain("is a valid config")
      expect(bundle.text).toContain('"passwordEnv": "SUPPORT_TEST_PASSWORD"')
      expect(bundle.text).toContain("- OT_GATEWAY_EDIT_TOKEN (set)")
      expect(bundle.text).toContain("(gateway-unreachable)")
      expect(bundle.text).not.toContain("s3cret-pw")
      expect(bundle.text).not.toContain("t0ken-value")
      const summary = formatSupportSummary("report.md", bundle)
      expect(summary).toMatch(/^ {2}status, events, logs: not available: .*gateway-unreachable/m)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("still writes the host when there is no config, and says so", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const bundle = yield* supportBundle({ config: join(folder, "ot-gateway.json"), env: {}, now: 0 })
      expect(bundle.sections.filter((section) => section.ok).map((section) => section.name)).toEqual([
        "host",
        "environment"
      ])
      expect(bundle.text).toContain("Not available: no config at")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it("names the file by the local time", () => {
    expect(supportFileName(new Date(2026, 10, 26, 7, 8, 9).getTime())).toBe("ot-gateway-support-20261126-070809.md")
  })
})
