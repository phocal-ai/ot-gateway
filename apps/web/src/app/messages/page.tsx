"use client"

/**
 * The Messages tab: what the gateway publishes to the broker, the latest message on each topic, as a client
 * subscribed to `site/building/#` receives it. Polls `/api/messages` every two seconds while open (the Status page
 * does not ask for it); the gateway keeps at most 2,000 topics. Search and a kind filter narrow the list, and only
 * the rows on screen are drawn. Read-only.
 */
import type { Messages } from "@ot-gateway/api"
import { useEffect, useMemo, useState } from "react"
import { useGateway, useListCount } from "@/components/gateway-shell"
import { POLL_MS, statusOf } from "@/components/live"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Combobox, type ComboboxOption } from "@/components/ui/combobox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/format"
import { countKinds, type MessageFilter, matchesMessage } from "@/lib/messages"
import { clockTime, fetchMessages, settle, type TopicKind, topicKind } from "@/lib/status"
import { useWindowRows } from "@/lib/virtual"

/** A row's height before the first one is measured (`h-14` and its border). */
const ROW_HEIGHT = 57

/** The last answer of `fetchMessages`, polled every two seconds while mounted, or undefined before the first. */
const useMessages = () => {
  const [messages, setMessages] = useState<Messages | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () =>
      settle(fetchMessages).then((result) => {
        if (cancelled) return
        if (result._tag === "Success") {
          setMessages(result.success)
          setFailed(undefined)
        } else setFailed(result.failure.message)
        timer = setTimeout(() => void poll(), POLL_MS)
      })
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  return { messages, failed }
}

const kindBadge = {
  value: "default",
  metadata: "secondary",
  health: "outline",
  "command result": "warning",
  other: "outline"
} as const

const kindLabels: ReadonlyArray<readonly [TopicKind, string]> = [
  ["value", "Values"],
  ["metadata", "Metadata"],
  ["health", "Health"],
  ["command result", "Command results"],
  ["other", "Other"]
]

const topicCount = (count: number) => `${formatNumber(count)} ${count === 1 ? "topic" : "topics"}`

const MessagesPage = () => {
  const status = statusOf(useGateway())
  const { messages: list, failed } = useMessages()
  const [filter, setFilter] = useState<MessageFilter>({ query: "", kind: "all" })
  const filtered = filter.query !== "" || filter.kind !== "all"
  const all = list?.messages ?? []
  const found = useMemo(() => all.filter((message) => matchesMessage(message, filter)), [all, filter])
  useListCount(list?.messages.length, filtered ? found.length : undefined, "topic")
  const { body, range, rowHeight } = useWindowRows(found.length, ROW_HEIGHT)
  const kindOptions = useMemo((): ReadonlyArray<ComboboxOption> => {
    const counts = countKinds(all)
    return [
      { value: "all", label: "All kinds", detail: topicCount(all.length) },
      ...kindLabels
        .filter(([kind]) => counts.has(kind) || kind === filter.kind)
        .map(([kind, label]) => ({ value: kind, label, detail: topicCount(counts.get(kind) ?? 0) }))
    ]
  }, [all, filter.kind])

  const prefix = status === undefined ? "" : `${status.site}/${status.building}/`
  const now = status?.now ?? Date.now()

  if (list === undefined)
    return (
      <p className="text-muted-foreground">
        {failed === undefined ? "Loading…" : `The gateway does not answer: ${failed}`}
      </p>
    )
  return (
    <>
      <p className="max-w-3xl text-sm text-muted-foreground">
        The latest message on each topic the gateway publishes: what a client subscribed to{" "}
        <code className="font-mono">{prefix}#</code> receives. A value goes to{" "}
        <code className="font-mono">site/building/device/point</code> as its publish mode says, its metadata to{" "}
        <code className="font-mono">…/$meta</code>, and the gateway&apos;s health to{" "}
        <code className="font-mono">…/$gateway/{status?.id ?? "id"}/health</code>.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-64">
          <input
            aria-label="Search messages"
            className={`h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:appearance-none ${filter.query === "" ? "" : "pr-20"}`}
            onChange={(event) => setFilter({ ...filter, query: event.target.value })}
            placeholder="Search topics and payloads…"
            type="search"
            value={filter.query}
          />
          {filter.query === "" ? null : (
            <button
              className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted"
              onClick={() => setFilter({ ...filter, query: "" })}
              type="button"
            >
              <span aria-hidden="true">✕</span>
              Reset
            </button>
          )}
        </div>
        <Combobox
          className="w-full sm:w-56"
          emptyText="No kind found."
          label="Kind"
          onChange={(kind) => setFilter({ ...filter, kind: kindOf(kind) ?? "all" })}
          options={kindOptions}
          searchPlaceholder="Search kinds…"
          value={filter.kind}
        />
      </div>
      <Card className="py-0">
        <CardContent className="px-0">
          {found.length === 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-6 text-sm text-muted-foreground">
              <p>{all.length === 0 ? "Nothing published yet." : "No message matches."}</p>
              {filtered ? (
                <button
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => setFilter({ query: "", kind: "all" })}
                  type="button"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <Table aria-rowcount={found.length + 1} containerClassName="overflow-clip rounded-xl">
              <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-0">
                <TableRow aria-rowindex={1} className="hover:bg-transparent">
                  <TableHead className="pl-4">Topic</TableHead>
                  <TableHead>Latest payload</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Messages</TableHead>
                  <TableHead className="pr-4 text-right">Sent at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={body}>
                {range.start === 0 ? null : <tr aria-hidden="true" style={{ height: range.start * rowHeight }} />}
                {found.slice(range.start, range.end).map((message, offset) => {
                  const index = range.start + offset
                  const kind = topicKind(message.topic)
                  const relative = message.topic.startsWith(prefix) ? message.topic.slice(prefix.length) : message.topic
                  return (
                    <TableRow aria-rowindex={index + 2} className="h-14" data-row={index} key={message.topic}>
                      <TableCell className="max-w-56 pl-4 sm:max-w-96">
                        <p className="truncate font-mono text-xs" title={message.topic}>
                          <span className="text-muted-foreground">{prefix}</span>
                          {relative}
                        </p>
                        <div className="mt-1 flex gap-1">
                          <Badge variant={kindBadge[kind]}>{kind}</Badge>
                          {message.retained ? (
                            <Badge
                              title="The broker keeps it and gives it to every subscriber that connects later"
                              variant="outline"
                            >
                              retained
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-40 sm:max-w-md">
                        <code className="block truncate font-mono text-xs" title={message.payload}>
                          {message.payload}
                          {message.truncated ? "…" : ""}
                        </code>
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">
                        {formatNumber(message.count)}
                      </TableCell>
                      <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">
                        {clockTime(message.at, now)}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {range.end === found.length ? null : (
                  <tr aria-hidden="true" style={{ height: (found.length - range.end) * rowHeight }} />
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {list.droppedTopics > 0 ? (
        <p className="text-sm text-muted-foreground">
          {formatNumber(list.droppedTopics)} more topics are not shown, and search does not find them: the gateway keeps
          the latest message of at most {formatNumber(list.messages.length)} topics.
        </p>
      ) : null}
    </>
  )
}

/** A kind from the filter's value, or undefined for one this page does not know. */
const kindOf = (value: string): TopicKind | undefined => kindLabels.find(([kind]) => kind === value)?.[0]

export default MessagesPage
