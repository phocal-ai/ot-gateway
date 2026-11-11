"use client"
/**
 * The status poll every page shares: `/api/status` every two seconds, then the events that are new since the last
 * poll (`/api/events?after=`, usually none), the next request only once these have settled, and the page's freshness
 * as one badge. While the gateway does not answer, the last status and the events known are kept.
 */
import type { GatewayStatus, PointReading } from "@ot-gateway/api"
import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { eventsAfter, type KnownEvents, mergeEvents } from "@/lib/events"
import { withReadings } from "@/lib/points"
import { fetchEvents, fetchStatus, fetchValues, settle } from "@/lib/status"

export const POLL_MS = 2000

export type Load =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly status: GatewayStatus }
  | { readonly _tag: "unreachable"; readonly last?: GatewayStatus }

/** The latest status, or the last one while the gateway does not answer. */
export const statusOf = (load: Load) =>
  load._tag === "ok" ? load.status : load._tag === "unreachable" ? load.last : undefined

/**
 * The status, and the gateway's events as far as the page has seen them (undefined until the first answer). The
 * events ride on the status poll: asked for right after each status, by the id of the newest known, so a quiet
 * gateway answers an empty list.
 */
export const useStatus = () => {
  const [load, setLoad] = useState<Load>({ _tag: "loading" })
  const [events, setEvents] = useState<KnownEvents | undefined>(undefined)
  const known = useRef<KnownEvents | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const askEvents = async (since: number) => {
      const result = await settle(fetchEvents(eventsAfter(known.current, since)))
      if (cancelled || result._tag !== "Success") return
      const next = mergeEvents(known.current, since, result.success)
      // A quiet poll changes nothing: keep the same object, so nothing renders for it.
      if (known.current !== undefined && next.since === known.current.since && result.success.events.length === 0)
        return
      known.current = next
      setEvents(next)
    }
    // The next request only once this one has settled: a slow gateway never gets them piled up.
    const poll = () =>
      settle(fetchStatus).then(async (result) => {
        if (cancelled) return
        setLoad((previous) => {
          if (result._tag === "Success") return { _tag: "ok", status: result.success }
          const last = statusOf(previous)
          return last === undefined ? { _tag: "unreachable" } : { _tag: "unreachable", last }
        })
        if (result._tag === "Success") await askEvents(result.success.since)
        if (cancelled) return
        timer = setTimeout(() => void poll(), POLL_MS)
      })
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  return { load, events }
}

/** Wait this long after the keys change before asking: a scroll changes the shown rows many times a second. */
const SETTLE_MS = 80

/**
 * The last reads of the points shown (`device/point` keys), asked for every two seconds like the status, and at
 * once (after `SETTLE_MS`) when the shown points change. What was read before stays known, so a row scrolled back
 * into view has its value while the next answer is on its way. While the gateway does not answer, the last reads
 * are kept; the status poll says it is unreachable.
 */
export const useValues = (keys: ReadonlyArray<string>) => {
  const wanted = keys.join(",")
  const [readings, setReadings] = useState<ReadonlyMap<string, PointReading>>(() => new Map())
  useEffect(() => {
    if (wanted === "") return
    const asked = wanted.split(",")
    let cancelled = false
    const poll = () =>
      settle(fetchValues(asked)).then((result) => {
        if (cancelled) return
        if (result._tag === "Success") setReadings((known) => withReadings(known, result.success))
        timer = setTimeout(() => void poll(), POLL_MS)
      })
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => void poll(), SETTLE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [wanted])
  return readings
}

/** The page's own freshness, once for everything on it: live while the gateway answers every two seconds. */
export const LiveBadge = ({ load }: { readonly load: Load }) => {
  switch (load._tag) {
    case "loading":
      return null
    case "unreachable":
      return <Badge variant="destructive">gateway unreachable</Badge>
    case "ok":
      return (
        <Badge variant="outline" title={`The page asks the gateway every ${POLL_MS / 1000} s`}>
          <span aria-hidden="true" className="size-2 rounded-full bg-success motion-safe:animate-pulse" />
          Live
        </Badge>
      )
  }
}
