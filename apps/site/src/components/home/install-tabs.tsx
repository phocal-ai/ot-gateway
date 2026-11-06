"use client"
/**
 * Step 1's picture: the two documented ways to install (README "Running it for real", docs/operations.md), as tabs.
 * compose.yaml comes from main, which holds the latest release and pins its image tag, so this stays right after a
 * release without an edit here. The two-command Docker install needs the folder layout of PR #98 (the release after
 * v0.7.0): publish this page with or after that release.
 */
import { useState } from "react"

const installs = [
  {
    id: "docker",
    label: "Docker",
    note: "recommended",
    lines: [
      "curl -fsSLO https://raw.githubusercontent.com/phocal-ai/ot-gateway/main/packaging/compose.yaml",
      "docker compose up -d"
    ],
    comment: "with ot-gateway.json next to compose.yaml"
  },
  {
    id: "systemd",
    label: "Without Docker",
    note: "",
    lines: [
      "git clone https://github.com/phocal-ai/ot-gateway.git && cd ot-gateway",
      "sudo packaging/install.sh ot-gateway.json"
    ],
    comment: "needs Node.js 22.18 or newer"
  }
] as const

type InstallId = (typeof installs)[number]["id"]

export const InstallTabs = () => {
  const [selected, setSelected] = useState<InstallId>("docker")
  const install = installs.find((candidate) => candidate.id === selected) ?? installs[0]

  return (
    <div className="w-full min-w-0 text-xs">
      <div aria-label="Ways to install" className="mb-3 flex gap-1 border-b" role="tablist">
        {installs.map((candidate) => {
          const active = candidate.id === selected
          return (
            <button
              aria-controls={`install-${candidate.id}`}
              aria-selected={active}
              className={`-mb-px border-b-2 px-2 pb-2 whitespace-nowrap transition-colors ${
                active
                  ? "text-fd-foreground border-[var(--series-1)] font-medium"
                  : "text-fd-muted-foreground hover:text-fd-foreground border-transparent"
              }`}
              id={`install-tab-${candidate.id}`}
              key={candidate.id}
              onClick={() => setSelected(candidate.id)}
              role="tab"
              type="button"
            >
              {candidate.label}
              {candidate.note === "" ? null : (
                <span className="text-fd-muted-foreground font-normal"> · {candidate.note}</span>
              )}
            </button>
          )
        })}
      </div>
      <pre
        aria-labelledby={`install-tab-${install.id}`}
        className="font-mono leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
        id={`install-${install.id}`}
        role="tabpanel"
      >
        <code>
          {install.lines.map((line) => (
            <span className="block" key={line}>
              <span className="text-fd-muted-foreground select-none">$ </span>
              {line}
            </span>
          ))}
          <span className="text-fd-muted-foreground block"># {install.comment}</span>
        </code>
      </pre>
    </div>
  )
}
