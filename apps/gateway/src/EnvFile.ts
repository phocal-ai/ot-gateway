/**
 * `./ot-gateway.env`, read into the environment when the CLI starts, so `ot-gateway run`, `watch` and `discover`
 * in the gateway's folder find the broker password where Docker Compose does (LoadConfig.ts reads the one next to a
 * config in another folder too). Variables already set win: the
 * shell, systemd's EnvironmentFile and the container's env_file all come first. A missing file is not an error.
 * Values are never logged.
 */
import { readFileSync } from "node:fs"
import { parseEnv } from "node:util"

export const envFileName = "ot-gateway.env"

/**
 * The variables of `text` that `env` does not set yet. Empty ones are left out: `init` writes the password line
 * empty, and an unset variable gets the gateway's clear "not set" error where an empty one would fail at the broker.
 */
export const missingFromEnv = (text: string, env: Readonly<Record<string, string | undefined>>) =>
  Object.entries(parseEnv(text)).filter(([name, value]) => value !== "" && env[name] === undefined)

/** Adds the variables of `./ot-gateway.env` that are not set already to `process.env`. */
export const loadEnvFile = (file = envFileName, env: Record<string, string | undefined> = process.env) => {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    // No file is the usual case outside a gateway folder. Anything else (permissions) is said, without the values.
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT"
    if (!missing) process.stderr.write(`ot-gateway: could not read ${file}: ${String(error)}\n`)
    return
  }
  for (const [name, value] of missingFromEnv(text, env)) env[name] = value
}
