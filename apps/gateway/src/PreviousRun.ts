/**
 * How the gateway's previous run ended, for the `gateway-started` event: a clean stop (SIGTERM from Docker, Ctrl-C)
 * or not (a crash, the power pulled, the OOM killer). Each run writes `ot-gateway-run.json` next to its outbox (or
 * its history) when it starts, `{started}`, and again on a clean stop, `{started, stopped}`. The next run reads it
 * first: a `stopped` time means a clean stop, none means the run before ended some other way.
 *
 * Two small writes per run, so nothing for an SD card. A file that cannot be read or written costs the answer, never
 * the gateway: it logs a warning and runs on.
 */
import { Effect, Exit, FileSystem, Option, type Path, Schema } from "effect"

/** The previous run as the next one tells it: when it started and, after a clean stop, when it stopped. */
export const PreviousRun = Schema.Struct({
  started: Schema.Number,
  stopped: Schema.optionalKey(Schema.Number)
})
export type PreviousRun = typeof PreviousRun.Type

const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(PreviousRun))

export const RUN_FILE = "ot-gateway-run.json"

/** Where the run file goes: next to the outbox, else next to the history; nowhere for a gateway with neither. */
export const runFilePath = (
  config: {
    readonly buffer?: { readonly path: string } | undefined
    readonly history?: { readonly path: string } | undefined
  },
  path: Path.Path
) => {
  const next = config.buffer?.path ?? config.history?.path
  return next === undefined ? undefined : path.join(path.dirname(next), RUN_FILE)
}

/**
 * Reads how the previous run ended, records this one's start, and on interruption (a clean stop) its stop. Returns
 * `None` for a first run, a gateway without an outbox or history, or a file it cannot read.
 */
export const trackRun = Effect.fn("trackRun")(function* (file: string, started: number) {
  const fs = yield* FileSystem.FileSystem
  const warn = (what: string) => (error: { readonly message: string }) =>
    Effect.logWarning(`could not ${what} ${file}, so the next start cannot tell how this run ended`).pipe(
      Effect.annotateLogs({ error: error.message })
    )
  const previous = yield* fs.readFileString(file).pipe(
    Effect.map(decodeRun),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", (error) => warn("read")(error).pipe(Effect.as(Option.none<PreviousRun>())))
  )
  const write = (run: PreviousRun) =>
    fs.writeFileString(file, `${JSON.stringify(run)}\n`).pipe(Effect.catchTag("PlatformError", warn("write")))
  yield* write({ started })
  yield* Effect.addFinalizer((exit) =>
    Exit.hasInterrupts(exit)
      ? Effect.flatMap(
          Effect.clockWith((clock) => clock.currentTimeMillis),
          (stopped) => write({ started, stopped })
        )
      : Effect.void
  )
  return previous
})
