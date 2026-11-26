/**
 * The status page's four tabs (README, "Look around"), in the home page's design. It says the same as the Mermaid
 * block it stands for; keep the two in step, and both in step with apps/web.
 */
import { Activity, List, MessagesSquare, Settings2 } from "lucide-react"
import type * as React from "react"
import { Eyebrow, Figure } from "./figure.tsx"

const tabs: ReadonlyArray<{
  readonly icon: React.ComponentType<{ readonly className?: string }>
  readonly name: string
  readonly question: string
  readonly shows: ReadonlyArray<string>
  readonly click: string
}> = [
  {
    icon: Activity,
    name: "Status",
    question: "Is everything working?",
    shows: [
      "Alarms, broker, devices, buffer and machine",
      "Every device with its health",
      "What broke lately, and when it came back"
    ],
    click: "a device: its error and what to check"
  },
  {
    icon: List,
    name: "Points",
    question: "What is this value now?",
    shows: ["Every point with its live value", "Search by id, name, topic or register"],
    click: "a point: its history, up to 7 days"
  },
  {
    icon: MessagesSquare,
    name: "Messages",
    question: "What reaches the broker?",
    shows: ["The latest message on each topic", "How many went out, per topic"],
    click: "a kind to filter: values, metadata, health, commands"
  },
  {
    icon: Settings2,
    name: "Settings",
    question: "What do I want to change?",
    shows: ["Gateway, broker and devices", "Add, find or upload devices, test before saving"],
    click: "Save to write it and apply it, no restart"
  }
]

export const StatusPageTabs = () => (
  <Figure label="The status page's four tabs and what each one answers">
    <div className="bg-fd-card rounded-xl border">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <Eyebrow>The status page</Eyebrow>
        <span className="text-fd-muted-foreground font-mono text-xs">http://localhost:8080</span>
      </div>
      <div className="grid divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        {tabs.map(({ icon: Icon, name, question, shows, click }, index) => (
          <div
            key={name}
            className={`flex flex-col gap-3 p-4 ${index % 2 === 1 ? "sm:border-l" : ""} ${index >= 2 ? "sm:border-t lg:border-t-0" : ""} lg:border-l-0`}
          >
            <div className="flex items-center gap-2">
              <Icon className="size-4 text-[var(--series-1)]" />
              <span className="text-sm font-medium">{name}</span>
            </div>
            <p className="text-sm">{question}</p>
            <ul className="text-fd-muted-foreground grid gap-1 text-xs">
              {shows.map((line) => (
                <li key={line} className="flex gap-2">
                  <span aria-hidden="true">·</span>
                  {line}
                </li>
              ))}
            </ul>
            <p className="text-fd-muted-foreground mt-auto border-t pt-3 text-xs">
              <span className="text-fd-foreground font-medium">Click</span> {click}
            </p>
          </div>
        ))}
      </div>
    </div>
  </Figure>
)
