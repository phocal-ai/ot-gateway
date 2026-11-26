/**
 * The table of codes (src/Codes.ts) is the one place a code is described: every code a command can report has a row,
 * and docs/troubleshooting.md's "Codes" table is the same table. A new `code: "…"` without a row fails here.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DeviceHealthPayload, RejectReason } from "@ot-gateway/core"
import { Result } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { BrokerFailureCode } from "../src/Broker.ts"
import { codes, codesTable, explainCode, failureClasses, findCode, formatCode, formatCodeList } from "../src/Codes.ts"

const sourceFolder = new URL("../src/", import.meta.url)
const troubleshooting = readFileSync(new URL("../../../docs/troubleshooting.md", import.meta.url), "utf8")

const isCode = (word: string) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(word)

/** Every literal code in this package's source: on a line that sets `code`, each quoted slug after it. */
const sourceCodes = () =>
  readdirSync(sourceFolder)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) =>
      readFileSync(new URL(file, sourceFolder), "utf8")
        .split("\n")
        .flatMap((line) => {
          const at = line.search(/\bcode: /)
          // A command's argument named code is not one.
          if (at < 0 || /\b(Argument|Flag)\./.test(line)) return []
          return [...line.slice(at).matchAll(/"([^"]+)"/g)].flatMap((match) => {
            const word = match[1] ?? ""
            return isCode(word) ? [{ file, code: word }] : []
          })
        })
    )

// Exhaustive by type: a reason added to the gateway without a row here fails the typecheck, and then the test.
const deviceReasons = {
  timeout: true,
  connection: true,
  protocol: true,
  "invalid-response": true,
  configuration: true,
  "not-implemented": true,
  "cycle-timeout": true,
  crashed: true
} satisfies Record<NonNullable<DeviceHealthPayload["reason"]>, true>
const rejectReasons = {
  retained: true,
  expired: true,
  "unknown-point": true,
  "not-writable": true,
  "invalid-payload": true,
  "wrong-type": true,
  "out-of-range": true
} satisfies Record<RejectReason, true>

/** A Markdown table's rows as trimmed cells, without the padding a formatter adds. */
const rows = (table: string) =>
  table
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim())
    )

describe("codes", () => {
  it("has a row for every code the source reports", () => {
    const known = new Set(codes.map((entry) => entry.code))
    const missing = sourceCodes().filter(({ code }) => !known.has(code))
    // Add a row to src/Codes.ts for each.
    expect(missing).toEqual([])
  })

  it("has a row for every broker failure, device failure class and command result", () => {
    const wanted = [
      ...BrokerFailureCode.literals,
      ...Object.keys(deviceReasons),
      ...Object.keys(rejectReasons),
      "device-unavailable"
    ]
    expect(wanted.filter((code) => findCode(code) === undefined)).toEqual([])
    expect([...failureClasses].toSorted()).toEqual(Object.keys(deviceReasons).toSorted())
  })

  it("has each code once, as a slug, in plain text a table cell can hold", () => {
    const all = codes.map((entry) => entry.code)
    expect(all.length).toBe(new Set(all).size)
    for (const entry of codes) {
      expect(entry.code).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      expect(entry.reportedBy).not.toEqual([])
      for (const text of [entry.meaning, entry.fix]) {
        expect(text).not.toMatch(/[|<>`]/)
        expect(text).toMatch(/\.$/)
      }
    }
  })

  it("is the table in docs/troubleshooting.md", () => {
    const section = troubleshooting.split(/^## /m).find((part) => part.startsWith("Codes\n")) ?? ""
    expect(
      rows(section),
      "docs/troubleshooting.md's Codes table: paste the output of ot-gateway explain --markdown there"
    ).toEqual(rows(codesTable()))
  })
})

const entryOf = (code: string) => findCode(code) ?? expect.unreachable(`no row for ${code}`)

describe("explain", () => {
  it("finds a code as a command result reads", () => {
    expect(findCode("rejected out-of-range")?.code).toBe("out-of-range")
    expect(findCode(" Failed Timeout ")?.code).toBe("timeout")
  })

  it("names the closest code to a mistyped one", () => {
    const result = explainCode("broker-unreachble")
    expect(Result.isFailure(result) && result.failure.message).toBe(
      'no code "broker-unreachble"; did you mean broker-unreachable?'
    )
    expect(Result.isFailure(result) && result.failure.code).toBe("unknown-code")
  })

  it("prints a device's failure class with what to check per protocol, and the command as the user runs it", () => {
    const text = formatCode(entryOf("timeout"), "npx ot-gateway")
    expect(text).toContain("Modbus TCP")
    expect(text).toContain("BACnet/IP")
    expect(text).toContain("next         npx ot-gateway read")
    expect(formatCode(entryOf("no-config"))).not.toContain("Modbus TCP")
  })

  it("lists every code under its area", () => {
    const list = formatCodeList()
    for (const entry of codes) expect(list).toContain(`  ${entry.code} `)
    expect(list.startsWith("The config\n")).toBe(true)
  })
})
