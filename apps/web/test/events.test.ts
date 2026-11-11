/**
 * The gateway's events as the page shows them: plain sentences with local times, kept across polls.
 */
import { describe, expect, it } from "@effect/vitest"
import type { EventLog, GatewayEvent } from "@ot-gateway/api"
import {
  deviceEvents,
  eventLine,
  eventSentence,
  eventsAfter,
  eventTone,
  isIncident,
  latestEvents,
  mergeEvents,
  nothingYet,
  plainError,
  sharedCauseNotes
} from "../src/lib/events.ts"

const at = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 10, 11, hours, minutes, seconds).getTime()
const now = at(12, 20, 0)

const started: GatewayEvent = { id: 1, at: at(12, 16, 2), type: "gateway-started", version: "0.9.0", devices: 3 }
const failing: GatewayEvent = {
  id: 2,
  at: at(12, 18, 20),
  type: "device-failing",
  device: "energy-meter",
  reason: "connection",
  error: "could not connect: connection refused by 127.0.0.1:5020"
}
const recovered: GatewayEvent = {
  id: 3,
  at: at(12, 19, 21),
  type: "device-recovered",
  device: "energy-meter",
  downMs: 61_000
}
const brokerGone: GatewayEvent = {
  id: 4,
  at: at(12, 19, 37),
  type: "broker-disconnected",
  error: "connection closed by the peer"
}
const brokerBack: GatewayEvent = { id: 5, at: at(12, 19, 57), type: "broker-connected", downMs: 20_000, buffered: 55 }
const drained: GatewayEvent = { id: 6, at: at(12, 19, 58), type: "buffer-drained" }
const conflict: GatewayEvent = {
  id: 7,
  at: at(12, 20, 0),
  type: "gateway-conflict",
  gateway: "roof",
  devices: ["energy-meter"],
  sameId: false
}

const log = (events: ReadonlyArray<GatewayEvent>, fields: Partial<EventLog> = {}): EventLog => ({
  now,
  events,
  capacity: 500,
  dropped: 0,
  ...fields
})

describe("eventSentence", () => {
  it("says what happened in plain words", () => {
    expect(eventSentence(started)).toBe("Gateway started (0.9.0, 3 devices)")
    expect(eventSentence(failing)).toBe("energy-meter stopped answering: connection refused by 127.0.0.1:5020")
    expect(eventSentence(recovered)).toBe("energy-meter answering again after 61 s")
    expect(eventSentence(brokerGone)).toBe("Broker disconnected: connection closed by the peer")
    expect(eventSentence(brokerBack)).toBe("Broker back after 20 s, 55 values from the buffer on their way")
    expect(eventSentence(drained)).toBe("Buffer emptied: every value kept while the broker was away reached it")
    expect(eventSentence(conflict)).toBe("Gateway roof publishes energy-meter too: values from both gateways mix")
    expect(eventSentence({ ...conflict, gateway: "main", devices: [], sameId: true })).toBe(
      "Another gateway with this gateway's id (main) is online: both publish into the same topics"
    )
  })

  it("leaves out what it does not know: the first connect, an empty buffer, a missing error", () => {
    expect(eventSentence({ id: 2, at: now, type: "broker-connected" })).toBe("Connected to the broker")
    expect(eventSentence({ ...brokerBack, buffered: 0 })).toBe("Broker back after 20 s")
    expect(eventSentence({ ...drained, delivered: 66 })).toBe("Buffer emptied: 66 values from it reached the broker")
    expect(eventSentence({ ...brokerBack, buffered: 1 })).toBe(
      "Broker back after 20 s, 1 value from the buffer on its way"
    )
    expect(eventSentence({ ...failing, error: "" })).toBe("energy-meter stopped answering: connection")
  })

  it("puts the local clock time in front", () => {
    expect(eventLine(failing, now)).toBe(
      "12:18:20 energy-meter stopped answering: connection refused by 127.0.0.1:5020"
    )
  })
})

describe("plainError", () => {
  it("drops the words the sentence already says, and keeps the rest", () => {
    expect(plainError("could not connect: host 10.0.0.9 unreachable")).toBe("host 10.0.0.9 unreachable")
    expect(plainError("could not connect")).toBe("could not connect")
    expect(plainError("no response to 4 item(s) within 3s")).toBe("no response to 4 item(s) within 3s")
  })
})

describe("isIncident", () => {
  it("does not count the start and the first connect to the broker as something that happened", () => {
    expect(isIncident(started)).toBe(false)
    expect(isIncident({ id: 2, at: now, type: "broker-connected", buffered: 0 })).toBe(false)
    expect(isIncident(brokerBack)).toBe(true)
    expect(isIncident(failing)).toBe(true)
    expect(isIncident(drained)).toBe(true)
  })
})

describe("eventTone", () => {
  it("marks failures bad and recoveries good", () => {
    expect(eventTone(failing)).toBe("bad")
    expect(eventTone(brokerGone)).toBe("bad")
    expect(eventTone(conflict)).toBe("bad")
    expect(eventTone(recovered)).toBe("good")
    expect(eventTone(brokerBack)).toBe("good")
    expect(eventTone(started)).toBe("neutral")
  })

  it("says what a save on the Settings tab did, a rollback in red", () => {
    const applied: GatewayEvent = { id: 7, at: now, type: "config-applied", summary: "gateway: site" }
    const rolledBack: GatewayEvent = { id: 8, at: now, type: "config-apply-failed", error: "the broker did not answer" }
    expect(eventSentence(applied)).toBe("Settings saved and applied: gateway: site")
    expect(eventSentence(rolledBack)).toBe(
      "Saved settings did not start, the previous ones run again: the broker did not answer"
    )
    expect(eventTone(applied)).toBe("neutral")
    expect(eventTone(rolledBack)).toBe("bad")
    expect(isIncident(applied)).toBe(true)
  })
})

describe("mergeEvents", () => {
  const since = at(12, 16, 0)

  it("asks for everything first, then only what is after the newest known", () => {
    expect(eventsAfter(undefined, since)).toBeUndefined()
    const known = mergeEvents(undefined, since, log([started, failing]))
    expect(eventsAfter(known, since)).toBe(2)
    const more = mergeEvents(known, since, log([recovered]))
    expect(more.events.map((event) => event.id)).toEqual([1, 2, 3])
  })

  it("keeps none twice when an answer repeats what is known", () => {
    const known = mergeEvents(undefined, since, log([started, failing]))
    expect(mergeEvents(known, since, log([failing, recovered])).events.map((event) => event.id)).toEqual([1, 2, 3])
  })

  it("starts over when the gateway restarted, as its ids count from 1 again", () => {
    const known = mergeEvents(undefined, since, log([started, failing, recovered]))
    expect(eventsAfter(known, since + 60_000)).toBeUndefined()
    const restarted = mergeEvents(known, since + 60_000, log([{ ...started, at: since + 60_000 }]))
    expect(restarted.events).toHaveLength(1)
    expect(restarted.since).toBe(since + 60_000)
  })

  it("keeps at most the gateway's capacity, letting the oldest go", () => {
    const known = mergeEvents(undefined, since, log([started, failing], { capacity: 3 }))
    const merged = mergeEvents(known, since, log([recovered, brokerGone], { capacity: 3, dropped: 1 }))
    expect(merged.events.map((event) => event.id)).toEqual([2, 3, 4])
    expect(merged.dropped).toBe(1)
  })
})

describe("deviceEvents and latestEvents", () => {
  const all = [started, failing, recovered, brokerGone, brokerBack, drained]

  it("picks one device's failures and recoveries", () => {
    expect(deviceEvents(all, "energy-meter")).toEqual([failing, recovered])
    expect(deviceEvents(all, "ahu-1")).toEqual([])
  })

  it("lists the newest first, as many as asked", () => {
    expect(latestEvents(all, 2)).toEqual([drained, brokerBack])
    expect(latestEvents([started], 10)).toEqual([started])
  })
})

describe("alarm events", () => {
  const raised: GatewayEvent = {
    id: 8,
    at: now,
    type: "alarm-raised",
    device: "energy-meter",
    point: "main-breaker-tripped",
    value: true
  }
  const known = new Map([["energy-meter/main-breaker-tripped", "Main breaker tripped"]])
  const names = (device: string, point: string) => known.get(`${device}/${point}`)

  it("name the point where the page knows its name", () => {
    expect(eventSentence(raised, names)).toBe("Alarm raised: Main breaker tripped on energy-meter")
    expect(eventSentence({ ...raised, first: true }, names)).toBe(
      "Alarm active at its first read: Main breaker tripped on energy-meter"
    )
    expect(
      eventSentence(
        {
          id: 9,
          at: now,
          type: "alarm-cleared",
          device: "energy-meter",
          point: "main-breaker-tripped",
          activeMs: 61_000
        },
        names
      )
    ).toBe("Alarm cleared after 61 s: Main breaker tripped on energy-meter")
  })

  it("fall back to device/point without a name, or when the name is the id", () => {
    expect(eventSentence(raised)).toBe("Alarm raised: energy-meter/main-breaker-tripped")
    expect(eventSentence(raised, () => "main-breaker-tripped")).toBe("Alarm raised: energy-meter/main-breaker-tripped")
    expect(eventSentence(raised, () => " ")).toBe("Alarm raised: energy-meter/main-breaker-tripped")
  })
})

describe("sharedCauseNotes", () => {
  const boilerFailing: GatewayEvent = { ...failing, id: 10, at: failing.at + 6_000, device: "boiler" }

  it("puts the shared-cause line on the newest failure of a group, as the CLI words it", () => {
    const notes = sharedCauseNotes([started, failing, boilerFailing, recovered])
    expect([...notes.keys()]).toEqual([10])
    expect(notes.get(10)).toBe(
      "2 devices (energy-meter, boiler) stopped answering within 6 s of each other: likely a shared cause (power, a switch, the gateway's own network)"
    )
  })

  it("has none for one device's failures", () => {
    expect(sharedCauseNotes([failing, recovered, { ...failing, id: 11, at: failing.at + 2_000 }]).size).toBe(0)
  })
})

describe("nothingYet", () => {
  it("says since when, to the minute", () => {
    expect(nothingYet(at(12, 16, 2), now)).toBe("Nothing has happened since the gateway started at 12:16.")
  })
})
