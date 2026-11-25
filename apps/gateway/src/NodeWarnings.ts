/**
 * Node's own warnings on stderr. Node 22 says once per process that
 * `node:sqlite` (the buffer and the history) is experimental; Node 24 does
 * not. To a person that line reads as an error, and to an agent it is noise
 * beside a command's one-line failure or its `--json` result, so the command
 * line leaves it out. Every other warning, experimental ones included, still
 * prints as Node prints it.
 */
import type { EventEmitter } from "node:events"

/** Whether a `warning` event's argument is Node's notice that `node:sqlite` is experimental. */
export const isSqliteExperimentalWarning = (warning: unknown): boolean =>
  warning instanceof Error &&
  warning.name === "ExperimentalWarning" &&
  warning.message.startsWith("SQLite is an experimental feature")

/**
 * Drops that one warning before Node's printer sees it. Node emits a warning
 * on the next tick, so calling this at the top of the entry point is in time
 * even though the import of `node:sqlite` came first. Not when the process
 * runs with module customization hooks (an `--import` that calls
 * `module.register`): loading is then asynchronous, and the notice prints
 * before the entry point's body runs.
 */
export const hideSqliteExperimentalWarning = (target: EventEmitter = process): void => {
  const emit = target.emit.bind(target)
  target.emit = (event: string | symbol, ...args: Array<unknown>) =>
    event === "warning" && isSqliteExperimentalWarning(args[0]) ? false : emit(event, ...args)
}
