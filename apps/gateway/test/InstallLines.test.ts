/**
 * The setup downloads the docs and the setup skill tell people and agents to paste. The wrapper's install line is the
 * same everywhere (packaging/ot-gateway's header is the reference), and every download retries, a failed name
 * lookup too: a router's DNS that drops out for a few seconds failed an install on a Pi.
 */
import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const repoFile = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const read = (path: string) => readFileSync(repoFile(path), "utf8")

/** Where a setup download is documented. Each is listed in this package's turbo.json test inputs. */
const sources = [
  "packaging/ot-gateway",
  "packaging/compose.yaml",
  "README.md",
  "docs/operations.md",
  "docs/raspberry-pi-install.md",
  "docs/raspberry-pi-testing.md",
  ".claude/skills/setup/SKILL.md"
]

/** The wrapper's install, from `mkdir` to `chmod`: what follows (`. ~/.profile`) differs by context. */
const wrapperInstall = /mkdir -p ~\/\.local\/bin && curl [^`\n]*? && chmod \+x ~\/\.local\/bin\/ot-gateway/g
const retries = "--retry 4 --retry-all-errors --retry-delay 2"

interface Found {
  readonly location: string
  readonly text: string
}

const findAll = (pattern: RegExp): ReadonlyArray<Found> =>
  sources.flatMap((path) =>
    read(path)
      .split("\n")
      .flatMap((line, index) =>
        [...line.matchAll(pattern)].map((match) => ({ location: `${path}:${index + 1}`, text: match[0] }))
      )
  )

describe("documented install lines", () => {
  it("installs the wrapper with the same line everywhere, the one in its own header", () => {
    const reference = read("packaging/ot-gateway").match(wrapperInstall)?.[0]
    expect(reference, "packaging/ot-gateway's header has no install line").toBeDefined()
    const found = findAll(wrapperInstall)
    const files = new Set(found.map((line) => line.location.split(":")[0]))
    expect(files).toEqual(
      new Set([
        ".claude/skills/setup/SKILL.md",
        "docs/operations.md",
        "docs/raspberry-pi-install.md",
        "packaging/ot-gateway"
      ])
    )
    const different = found.filter((line) => line.text !== reference).map((line) => `${line.location}: ${line.text}`)
    expect(different, `install lines other than packaging/ot-gateway's: ${reference}`).toEqual([])
  })

  it("retries every download, a failed name lookup too", () => {
    const downloads = findAll(/curl -fsSLO? [^`|\n]*/g)
    expect(downloads.length).toBeGreaterThan(5)
    const without = downloads.filter((line) => !line.text.includes(retries)).map((line) => line.location)
    expect(without, `downloads without ${retries}`).toEqual([])
  })
})
