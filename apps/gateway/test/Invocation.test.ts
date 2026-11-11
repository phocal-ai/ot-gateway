/**
 * The next commands `init`, `discover` and `import` print can be run as printed: `pnpm ot-gateway` in a checkout,
 * `npx ot-gateway` through npx, `ot-gateway` otherwise.
 */
import { describe, expect, it } from "@effect/vitest"
import { parseConfig } from "@ot-gateway/core"
import { ConfigProvider, Effect } from "effect"
import { importCommand } from "../src/Discover.ts"
import { initNext } from "../src/Init.ts"
import { cliCommand, invocation } from "../src/Invocation.ts"

describe("cliCommand", () => {
  it("is pnpm ot-gateway for the checkout's root script run by pnpm", () => {
    expect(
      cliCommand({
        npm_lifecycle_event: "ot-gateway",
        npm_execpath: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs",
        npm_config_user_agent: "pnpm/10.28.0 npm/? node/v24.11.0 darwin arm64"
      })
    ).toBe("pnpm ot-gateway")
    // Only the user agent says so.
    expect(cliCommand({ npm_lifecycle_event: "ot-gateway", npm_config_user_agent: "pnpm/10.28.0" })).toBe(
      "pnpm ot-gateway"
    )
  })

  it("is the script through npm or yarn, npx through npx, and ot-gateway otherwise", () => {
    expect(
      cliCommand({ npm_lifecycle_event: "ot-gateway", npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" })
    ).toBe("npm run ot-gateway --")
    expect(cliCommand({ npm_lifecycle_event: "ot-gateway", npm_config_user_agent: "yarn/1.22.22 npm/?" })).toBe(
      "yarn ot-gateway"
    )
    expect(cliCommand({ npm_lifecycle_event: "npx", npm_command: "exec" })).toBe("npx ot-gateway")
    expect(cliCommand({})).toBe("ot-gateway")
    // Another script that happens to run the CLI (a test run, say) is not the CLI's own script.
    expect(cliCommand({ npm_lifecycle_event: "test", npm_config_user_agent: "pnpm/10.28.0" })).toBe("ot-gateway")
  })

  it.effect("reads the process's environment", () =>
    Effect.gen(function* () {
      const command = yield* invocation.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ npm_lifecycle_event: "ot-gateway", npm_config_user_agent: "pnpm/10.28.0" })
          )
        )
      )
      expect(command).toBe("pnpm ot-gateway")
    })
  )
})

describe("the next commands", () => {
  it.effect("start with the command that ran the CLI", () =>
    Effect.gen(function* () {
      const config = yield* parseConfig(
        JSON.stringify({ site: "s", building: "b", mqtt: { url: "mqtt://localhost:1883" }, devices: [] })
      )
      const { next } = initNext("site-1/ot-gateway.json", config, undefined, { command: "pnpm ot-gateway", cwd: "." })
      expect(next.map((step) => step.command)).toContain("pnpm ot-gateway check site-1/ot-gateway.json")
      expect(next.every((step) => !step.command.startsWith("ot-gateway"))).toBe(true)
      expect(initNext("ot-gateway.json", config, undefined, { cwd: "." }).next[0]?.command).toBe("ot-gateway broker")
      expect(importCommand("points.csv", "site-1/ot-gateway.json", "pnpm ot-gateway")).toBe(
        "pnpm ot-gateway import points.csv site-1/ot-gateway.json"
      )
    })
  )
})
