/** Node's notice that `node:sqlite` is experimental stays off stderr; every other warning still reaches Node's printer. */
import { describe, expect, it } from "@effect/vitest"
import { EventEmitter } from "node:events"
import { hideSqliteExperimentalWarning, isSqliteExperimentalWarning } from "../src/NodeWarnings.ts"

const warning = (name: string, message: string) => Object.assign(new Error(message), { name })
/** As Node 22.18 emits it. */
const sqlite = warning("ExperimentalWarning", "SQLite is an experimental feature and might change at any time")

describe("Node's warnings", () => {
  it("knows the node:sqlite notice from other warnings", () => {
    expect(isSqliteExperimentalWarning(sqlite)).toBe(true)
    expect(
      isSqliteExperimentalWarning(warning("ExperimentalWarning", "Type Stripping is an experimental feature"))
    ).toBe(false)
    expect(isSqliteExperimentalWarning(warning("DeprecationWarning", "SQLite something is deprecated"))).toBe(false)
    // Another experimental SQLite feature, should Node name one, is news and prints.
    expect(isSqliteExperimentalWarning(warning("ExperimentalWarning", "SQLite sessions are experimental"))).toBe(false)
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature")).toBe(false)
  })

  it("drops only that notice, and leaves other warnings and other events to their listeners", () => {
    const target = new EventEmitter()
    const seen: Array<unknown> = []
    target.on("warning", (value) => seen.push(value))
    target.on("exit", (code) => seen.push(code))
    hideSqliteExperimentalWarning(target)
    const other = warning("ExperimentalWarning", "Type Stripping is an experimental feature")
    expect(target.emit("warning", sqlite)).toBe(false)
    expect(target.emit("warning", other)).toBe(true)
    expect(target.emit("exit", 0)).toBe(true)
    expect(seen).toEqual([other, 0])
  })
})
