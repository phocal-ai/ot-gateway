/**
 * The tests' virtual time waits for the disk: a file operation in flight (a slow fsync on a CI runner) holds the
 * clock, so a deadline in the gateway cannot pass while it is only waiting on a write.
 */
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber } from "effect"
import { execFileSync } from "node:child_process"
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { settle } from "./support/VirtualTime.ts"

/** Open `fifo`'s writing end without waiting, which lets a reader waiting on it go on; false when none waits. */
const releaseReader = (fifo: string) => {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
    return true
  } catch {
    return false
  }
}

/**
 * A file request that stays in flight until `release`, as a slow fsync does: opening a FIFO for reading waits in the
 * thread pool until a writer opens it. Released and removed with the scope, so a failing test cannot leave it hanging.
 */
const pendingFileRequest = Effect.acquireRelease(
  Effect.sync(() => {
    const folder = mkdtempSync(join(tmpdir(), "virtual-time-"))
    const fifo = join(folder, "fifo")
    execFileSync("mkfifo", [fifo])
    const reading = open(fifo, "r")
    return { folder, fifo, reading }
  }),
  ({ folder, fifo, reading }) =>
    Effect.promise(async () => {
      releaseReader(fifo)
      await reading.then((handle) => handle.close()).catch(() => undefined)
      rmSync(folder, { recursive: true, force: true })
    })
)

// mkfifo is POSIX; CI and the Pi run Linux.
describe.skipIf(process.platform === "win32")("virtual time in tests", () => {
  it.effect("does not move while a file operation is in flight, and moves on once it is done", () =>
    Effect.gen(function* () {
      const { fifo, reading } = yield* pendingFileRequest
      const start = yield* Clock.currentTimeMillis
      const moving = yield* settle(4).pipe(Effect.forkScoped)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect(yield* Clock.currentTimeMillis).toBe(start)
      expect(moving.pollUnsafe()).toBeUndefined()
      expect(releaseReader(fifo)).toBe(true)
      yield* Effect.promise(() => reading)
      yield* Fiber.join(moving)
      expect(yield* Clock.currentTimeMillis).toBe(start + 2000)
    }).pipe(Effect.scoped)
  )
})
