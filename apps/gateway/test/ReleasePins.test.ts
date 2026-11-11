/**
 * A release moves its tag by hand in compose.yaml, the packaging/ot-gateway wrapper and the docs. The compose pin is
 * the reference: every other pin must carry the same tag, so a missed one fails here instead of on a user's machine.
 */
import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const repoFile = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const read = (path: string) => readFileSync(repoFile(path), "utf8")

const tagShape = String.raw`v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`
const composePin = new RegExp(String.raw`OT_GATEWAY_TAG:-(${tagShape})`)
const wrapperPin = new RegExp(String.raw`^release=(${tagShape})\s*$`, "m")
const docPins = [
  new RegExp(String.raw`ghcr\.io/phocal-ai/ot-gateway:(${tagShape})`, "g"),
  new RegExp(String.raw`phocal-ai/ot-gateway/(${tagShape})/`, "g"),
  new RegExp(String.raw`git checkout (${tagShape})`, "g"),
  new RegExp(String.raw`OT_GATEWAY_TAG:-(${tagShape})`, "g")
]
const docs = ["docs/operations.md", "docs/raspberry-pi-testing.md"]

interface Pin {
  readonly location: string
  readonly tag: string
}

const pinsIn = (path: string): ReadonlyArray<Pin> =>
  read(path)
    .split("\n")
    .flatMap((line, index) =>
      docPins.flatMap((shape) =>
        [...line.matchAll(shape)].map((match) => ({ location: `${path}:${index + 1}`, tag: match[1] ?? "" }))
      )
    )

const releaseTag = (() => {
  const tag = composePin.exec(read("packaging/compose.yaml"))?.[1]
  if (tag === undefined) throw new Error("packaging/compose.yaml has no OT_GATEWAY_TAG:-vX.Y.Z default")
  return tag
})()

describe("release pins", () => {
  it("packaging/ot-gateway runs the image compose.yaml pins", () => {
    const lines = read("packaging/ot-gateway").split("\n")
    const index = lines.findIndex((line) => wrapperPin.test(line))
    const tag = wrapperPin.exec(lines[index] ?? "")?.[1]
    const found = tag === undefined ? "no release=vX.Y.Z line" : `packaging/ot-gateway:${index + 1}: ${tag}`
    expect(tag, `${found}, compose.yaml pins ${releaseTag}`).toBe(releaseTag)
  })

  it.each(docs)("%s pins the tag compose.yaml pins, everywhere", (path) => {
    const pins = pinsIn(path)
    expect(pins.length, `${path} holds no release pin`).toBeGreaterThan(0)
    const stale = pins.filter((pin) => pin.tag !== releaseTag).map((pin) => `${pin.location}: ${pin.tag}`)
    expect(stale, `pins other than ${releaseTag} (compose.yaml)`).toEqual([])
  })
})
