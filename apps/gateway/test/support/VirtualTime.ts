/**
 * Virtual time for tests that drive a running gateway over real I/O (HTTP, files, SQLite) while its timers run on
 * the `TestClock`.
 *
 * Moving the clock on a fixed real-time beat races the file system: a save from the status page writes and fsyncs
 * the config and its `.bak`, and on a slow CI disk one fsync can take longer than the 50 beats in which the page's
 * 25-second apply deadline passed, so the save answered 422 though nothing went wrong. In the gateway those writes
 * take milliseconds of a 25-second deadline; here the clock waits for them, so it moves only while the gateway waits
 * on time.
 */
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

/**
 * How long one step waits for file operations in flight before it moves the clock regardless: well inside vitest's
 * 5-second test timeout, so a file request that never ends shows as the test's own failure, not as a timeout.
 */
const FILE_WAIT_LIMIT_MS = 2_000

/**
 * Whether a file operation (an open, a write, an fsync, a rename) is waiting on the disk. Any in the process
 * counts, not only the gateway's: a test that leaves one behind slows the next steps by up to the limit, no more.
 */
const fileWorkPending = () => process.getActiveResourcesInfo().some((resource) => resource.startsWith("FSReq"))

const pause = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

/**
 * Wait, in real time, until no file operation has been in flight for two looks a millisecond apart, or for
 * `FILE_WAIT_LIMIT_MS` at most. Two looks, since a save is a chain (open, write, fsync, close, chmod, rename): between
 * one finishing and the gateway asking for the next, a single look would see none.
 */
const fileWorkDone = Effect.gen(function* () {
  const deadline = performance.now() + FILE_WAIT_LIMIT_MS
  let quiet = 0
  while (quiet < 2 && performance.now() < deadline) {
    quiet = fileWorkPending() ? 0 : quiet + 1
    if (quiet < 2) yield* pause(1)
  }
})

/** Let real I/O (sockets, SQLite, HTTP, files) and virtual time move on together, `steps` half-seconds of the latter. */
export const settle = (steps: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < steps; step++) {
      yield* pause(2)
      yield* fileWorkDone
      yield* TestClock.adjust("500 millis")
    }
  })

/** Run `request` (an HTTP call into the gateway) while virtual time moves on, as the gateway may wait on it. */
export const whileTimePasses = <A>(request: () => Promise<A>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.promise(request).pipe(Effect.forkScoped)
    for (let step = 0; step < 200 && fiber.pollUnsafe() === undefined; step++) yield* settle(1)
    return yield* Fiber.join(fiber)
  })
