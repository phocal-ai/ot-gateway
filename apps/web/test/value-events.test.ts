/**
 * What #165 added to the events, as the page shows them: energy counters that went back or jumped, merged with the
 * other events by id; one duration per outage; the shared cause on one host; the flapping-alarm hint.
 */
import { describe, expect, it } from "@effect/vitest"
import type { EventLog, GatewayEvent, ValueEvent } from "@ot-gateway/api"
import {
  counterNote,
  deviceEvents,
  eventDetail,
  eventDetailTitle,
  eventNote,
  eventSentence,
  eventsAfter,
  eventTone,
  hostsOf,
  isIncident,
  mergeEvents,
  pointCounterEvents,
  sharedCauseNotes,
  sharedFailure
} from "../src/lib/events.ts"
import { failingSinceText } from "../src/lib/status.ts"

const at = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 10, 11, hours, minutes, seconds).getTime()
const now = at(18, 40, 0)

const failing: GatewayEvent = {
  id: 2,
  at: at(18, 33, 11),
  type: "device-failing",
  device: "energy-meter",
  reason: "timeout",
  error: "timed out after 3 s",
  answeredBefore: true,
  lastReadAt: at(18, 33, 3)
}
const recovered: GatewayEvent = {
  id: 4,
  at: at(18, 35, 23),
  type: "device-recovered",
  device: "energy-meter",
  downMs: 132_000,
  lastReadAt: at(18, 33, 3),
  failingSince: at(18, 33, 11),
  noDataMs: 140_000
}
const wentBack: ValueEvent = {
  id: 5,
  at: at(18, 35, 24),
  type: "counter-went-back",
  device: "energy-meter",
  point: "energy",
  unit: "unit:KiloW-HR",
  from: 4270,
  to: 120
}
const jumped: ValueEvent = {
  id: 3,
  at: at(18, 34, 0),
  type: "counter-jumped",
  device: "energy-meter",
  point: "energy",
  unit: "kWh",
  from: 4270,
  to: 9800,
  elapsedMs: 30_000,
  usualPerHour: 12.5
}
const names = (device: string, point: string) =>
  device === "energy-meter" && point === "energy" ? "Energy counter" : undefined

const log = (events: ReadonlyArray<GatewayEvent>, valueEvents?: ReadonlyArray<ValueEvent>): EventLog => ({
  now,
  events,
  ...(valueEvents === undefined ? {} : { valueEvents }),
  capacity: 500,
  dropped: 0
})

describe("counter events", () => {
  it("name the point and say what the counter did, as the CLI does", () => {
    expect(eventSentence(wentBack, names)).toBe(
      "Energy counter on energy-meter went back from 4,270 to 120 kWh: meter reset or replaced?"
    )
    expect(eventSentence(jumped)).toBe(
      "energy-meter/energy jumped from 4,270 to 9,800 kWh in 30 s, more than 10× its fastest rise of the last hour (12.5 kWh/h): meter reset or replaced, or another device answering at its address?"
    )
  })

  it("are a warning, not an alarm, and something that happened", () => {
    expect(eventTone(wentBack)).toBe("warning")
    expect(eventTone(jumped)).toBe("warning")
    expect(isIncident(wentBack)).toBe(true)
  })

  it("go in among the gateway's events by id, and the next ask is after the newest of all", () => {
    const known = mergeEvents(undefined, 1, log([failing, recovered], [jumped, wentBack]))
    expect(known.events.map((event) => event.id)).toEqual([2, 3, 4, 5])
    expect(eventsAfter(known, 1)).toBe(5)
    const next = mergeEvents(known, 1, log([], [{ ...wentBack, id: 6 }, wentBack]))
    expect(next.events.map((event) => event.id)).toEqual([2, 3, 4, 5, 6])
  })

  it("decode an answer from an older gateway without value events", () => {
    expect(mergeEvents(undefined, 1, log([failing])).events).toEqual([failing])
  })

  it("belong to their device's events and their point's notes", () => {
    const events = [failing, jumped, recovered, wentBack, { ...wentBack, id: 9, device: "boiler" }]
    expect(deviceEvents(events, "energy-meter").map((event) => event.id)).toEqual([2, 3, 4, 5])
    expect(pointCounterEvents(events, "energy-meter", "energy").map((event) => event.id)).toEqual([3, 5])
    expect(pointCounterEvents(events, "energy-meter", "power")).toEqual([])
    expect(counterNote(wentBack, now)).toBe(
      "At 18:35:24 the counter went back from 4,270 to 120 kWh: meter reset or replaced?"
    )
  })
})

describe("one duration per outage", () => {
  it("gives a recovery the span the data shows, from the last read to the first read again", () => {
    expect(eventSentence(recovered, undefined, now)).toBe(
      "energy-meter answering again: no data 18:33:03–18:35:23 (2 min 20 s)"
    )
  })

  it("keeps the detection time out of the main line, in a muted detail and its hover", () => {
    expect(eventDetail(recovered, now)).toBe("detected 18:33:11")
    expect(eventDetailTitle(recovered)).toContain("2 min 12 s")
    expect(eventDetail(failing, now)).toBeUndefined()
  })

  it("says when the data stopped on a failure", () => {
    expect(eventSentence(failing, undefined, now)).toBe(
      "energy-meter stopped answering: timed out after 3 s, last read 18:33:03"
    )
  })

  it("words an older gateway's recovery as before", () => {
    const old: GatewayEvent = { id: 4, at: at(18, 35, 23), type: "device-recovered", device: "meter", downMs: 61_000 }
    expect(eventSentence(old)).toBe("meter answering again after 61 s")
    expect(eventDetail(old, now)).toBeUndefined()
  })

  it("gives a failing device's row no data since its last read, else since it was marked failing", () => {
    expect(failingSinceText({ lastSuccess: at(18, 33, 3), failingSince: at(18, 33, 11) }, at(18, 36, 3))).toBe(
      "no data since 18:33:03 (3 min)"
    )
    expect(failingSinceText({ failingSince: at(18, 33, 11) }, at(18, 36, 11))).toBe("failing since 18:33:11 (3 min)")
    expect(failingSinceText({}, now)).toBeUndefined()
  })
})

describe("shared cause on one host", () => {
  const second: GatewayEvent = { ...failing, id: 7, at: failing.at + 2_000, device: "heat-meter" }
  const third: GatewayEvent = { ...failing, id: 8, at: failing.at + 30_000, device: "boiler" }
  const hostOf = hostsOf([
    { id: "energy-meter", host: "10.0.1.20" },
    { id: "heat-meter", host: "10.0.1.20" },
    { id: "boiler" }
  ])

  it("names the host the devices share, with the shared helper's words", () => {
    expect(sharedCauseNotes([failing, second], hostOf).get(7)).toBe(
      "2 devices (energy-meter, heat-meter) stopped answering within 2 s of each other, both on 10.0.1.20: likely the host itself, its power or its network link"
    )
  })

  it("tells the device sheet's hints that its failure was shared, and on which host", () => {
    const shared = sharedFailure([failing, second, third], "heat-meter", hostOf)
    expect(shared.context).toEqual({ sharedCause: true, sharedHost: "10.0.1.20" })
    expect(shared.line).toContain("both on 10.0.1.20")
    expect(sharedFailure([failing, second, third], "boiler", hostOf)).toEqual({ context: {} })
  })
})

describe("eventNote", () => {
  it("says what a flapping alarm's rhythm usually means, and nothing for other events", () => {
    const flapping: GatewayEvent = {
      id: 12,
      at: now,
      type: "alarm-flapping",
      device: "energy-meter",
      point: "breaker",
      raised: 6,
      pattern: { raised: 6, overMs: 360_000 }
    }
    expect(eventNote(flapping)).toContain("wiring or contact")
    expect(eventNote(failing)).toBeUndefined()
  })
})
