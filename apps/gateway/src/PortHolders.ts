/**
 * Which processes hold a UDP port, so `doctor` can tell another ot-gateway command (a `read` or `discover` at work)
 * apart from a foreign program on the BACnet/IP port. `lsof` on macOS (and Linux where it is installed), else `ss`;
 * then `ps` for each pid's command line. Best effort: a tool that is missing, slow or refused finds nobody, and says
 * why in the debug log.
 */
import { Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PortHolder } from "./Doctor.ts"

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.mkString(Stream.decodeText(stream)).pipe(Effect.orElseSucceed(() => ""))

/** What a command prints on stdout, or nothing when it cannot run, fails or takes longer than two seconds. */
const output = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
    const [text, code] = yield* Effect.all([collect(handle.stdout), handle.exitCode], { concurrency: "unbounded" })
    return Number(code) === 0 ? text : ""
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption("2 seconds"),
    Effect.map(Option.getOrElse(() => "")),
    Effect.catch((error) => Effect.as(Effect.logDebug(`${command} could not run: ${error.message}`), ""))
  )

/** The pids in `lsof -t` output (one per line) or in `ss -p` output (`pid=123`). */
export const pidsIn = (text: string): ReadonlyArray<number> => {
  const found = [...text.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))
  const listed = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
  return [...new Set([...found, ...listed])].filter((pid) => pid > 0 && pid !== process.pid)
}

/** The processes holding UDP `port` on this machine, each with its command line. */
export const udpPortHolders = Effect.fn("udpPortHolders")(function* (port: number) {
  const lsof = yield* output("lsof", ["-nP", "-t", `-iUDP:${port}`])
  const pids = pidsIn(lsof !== "" ? lsof : yield* output("ss", ["-Hulpn", `sport = :${port}`]))
  return yield* Effect.forEach(
    pids.slice(0, 4),
    (pid) =>
      Effect.map(output("ps", ["-o", "command=", "-p", String(pid)]), (text): PortHolder => ({
        pid,
        command: text.trim()
      })),
    { concurrency: 4 }
  ).pipe(Effect.map((holders) => holders.filter((holder) => holder.command !== "")))
})
