/**
 * Which build of the gateway is running: the `VERSION` file at the root of
 * the installation, written by the container build (the release tag) and by
 * `packaging/install.sh` (`git describe`). A checkout run from source has
 * none and reports `dev`. Telemetry, the health of a fleet and the status
 * page all need to tell builds apart; the packages' own versions do not move.
 */
import { Effect, FileSystem } from "effect"
import { fileURLToPath } from "node:url"

export const versionFile = fileURLToPath(new URL("../../../VERSION", import.meta.url))

/** A tag, a `git describe` or a commit: short, and safe to put in a metric attribute. */
const plausible = /^[\w.+-]{1,64}$/

export const parseVersion = (text: string): string | undefined => {
  const trimmed = text.trim()
  return plausible.test(trimmed) ? trimmed : undefined
}

export const readVersion: Effect.Effect<string, never, FileSystem.FileSystem> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(versionFile).pipe(Effect.orElseSucceed(() => ""))
  return parseVersion(text) ?? "dev"
})
