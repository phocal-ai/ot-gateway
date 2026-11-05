import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"
import { site } from "./site.ts"

export const baseOptions = (): BaseLayoutProps => ({
  nav: {
    title: <span className="font-semibold tracking-tight">OT Gateway</span>,
    url: "/"
  },
  githubUrl: site.repository,
  links: [{ text: "Docs", url: "/docs", active: "nested-url" }]
})
