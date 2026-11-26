"use client"

import { useEffect, useId, useState } from "react"

/**
 * A Mermaid diagram from a docs page's ```mermaid block (source.config.ts turns the block into this component),
 * so the same Markdown draws on GitHub and here. Mermaid is loaded in the browser, only on a page that has a
 * diagram; until it has drawn, and without JavaScript, the reader sees the diagram's source.
 */

/** Mermaid takes literal colors, not CSS variables: Fumadocs' neutral theme, light and dark. */
const palette = {
  light: { background: "#ffffff", surface: "#f5f5f5", border: "#a3a3a3", text: "#171717", line: "#737373" },
  dark: { background: "#0a0a0a", surface: "#1f1f1f", border: "#525252", text: "#ededed", line: "#a3a3a3" }
} as const

const isDark = (): boolean => document.documentElement.classList.contains("dark")

/** Whether the site is in dark mode, following the theme switch; undefined until the browser has said. */
const useDark = (): boolean | undefined => {
  const [dark, setDark] = useState<boolean>()
  useEffect(() => {
    setDark(isDark())
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export const Mermaid = ({ chart }: { readonly chart: string }) => {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "")
  const dark = useDark()
  const [svg, setSvg] = useState<string>()

  useEffect(() => {
    // Not before the theme is known: a dark page would draw every diagram in light first.
    if (dark === undefined) return
    let current = true
    const draw = async () => {
      const { default: mermaid } = await import("mermaid")
      const colors = dark ? palette.dark : palette.light
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // Without it Mermaid leaves its own "syntax error" drawing in the page when a diagram does not parse.
        suppressErrorRendering: true,
        fontFamily: "inherit",
        theme: "base",
        // Labels are measured before the page's font applies, so they get room and break only at <br/>.
        flowchart: { wrappingWidth: 400, nodeSpacing: 36, rankSpacing: 40, padding: 12 },
        themeVariables: {
          darkMode: dark,
          background: colors.background,
          primaryColor: colors.surface,
          primaryBorderColor: colors.border,
          primaryTextColor: colors.text,
          secondaryColor: colors.surface,
          tertiaryColor: colors.background,
          lineColor: colors.line,
          textColor: colors.text,
          clusterBkg: colors.background,
          clusterBorder: colors.border,
          edgeLabelBackground: colors.background,
          actorBkg: colors.surface,
          actorBorder: colors.border,
          signalColor: colors.line,
          signalTextColor: colors.text,
          noteBkgColor: colors.surface,
          noteBorderColor: colors.border,
          noteTextColor: colors.text,
          fontSize: "14px"
        }
      })
      const drawn = await mermaid.render(`mermaid-${id}-${dark ? "dark" : "light"}`, chart)
      if (current) setSvg(drawn.svg)
    }
    // A diagram that does not parse stays as its source, which the reader can still follow.
    draw().catch(() => undefined)
    return () => {
      current = false
    }
  }, [chart, dark, id])

  if (svg === undefined) {
    return (
      <pre className="text-fd-muted-foreground overflow-x-auto rounded-lg border p-4 text-xs">
        <code>{chart}</code>
      </pre>
    )
  }
  return (
    <div
      className="my-6 overflow-x-auto rounded-lg border p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid's own output, drawn with securityLevel strict from Markdown in this repository.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
