/**
 * How the gateway's previous run ended, for the `gateway-started` event: a clean stop (SIGTERM from Docker, Ctrl-C)
 * or not (a crash, the power pulled, the OOM killer). Each run writes `ot-gateway-run.json` next to its outbox (or
 * its history) when it starts, `{started}`, and again on a clean stop, `{started, stopped}`. The next run reads it
 * first: a `stopped` time means a clean stop, none means the run before ended some other way.
 *
 * Two small writes per run, so nothing for an SD card. A file that cannot be read or written costs the answer, never
 * the gateway: it logs a warning and runs on. Each read and write has a deadline (`RUN_FILE_DEADLINE`), so a card
 * that hangs cannot hold the gateway's start before it connects, nor its stop.
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

/** How long one read or write of the run file may take before the gateway gives up on it and runs on. */
export const RUN_FILE_DEADLINE = "5 seconds"

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
    Effect.logWarning(`could not ${what} ${file}`).pipe(Effect.annotateLogs({ error: error.message }))
  const timedOut = { message: `no answer within ${RUN_FILE_DEADLINE}` }
  const unread = warn("read")
  const unwritten = (error: { readonly message: string }) =>
    Effect.logWarning(`could not write ${file}, so the next start cannot tell how this run ended`).pipe(
      Effect.annotateLogs({ error: error.message })
    )
  const previous = yield* fs.readFileString(file).pipe(
    Effect.map(decodeRun),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", (error) => unread(error).pipe(Effect.as(Option.none<PreviousRun>()))),
    Effect.timeoutOrElse({
      duration: RUN_FILE_DEADLINE,
      orElse: () => unread(timedOut).pipe(Effect.as(Option.none<PreviousRun>()))
    })
  )
  // Written beside the file and renamed over it, so a write cut short (by the deadline, or the power) leaves the
  // run file as it was rather than empty or half-written.
  const pending = `${file}.tmp`
  const write = (run: PreviousRun) =>
    fs
      .writeFileString(pending, `${JSON.stringify(run)}\n`)
      .pipe(
        Effect.andThen(fs.rename(pending, file)),
        Effect.catchTag("PlatformError", unwritten),
        Effect.timeoutOrElse({ duration: RUN_FILE_DEADLINE, orElse: () => unwritten(timedOut) })
      )
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
