import { DocsLayout } from "fumadocs-ui/layouts/docs"
import type * as React from "react"
import { baseOptions } from "@/lib/layout.shared.tsx"
import { source } from "@/lib/source.ts"

const Layout = ({ children }: { readonly children: React.ReactNode }) => (
  <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
    {children}
  </DocsLayout>
)

export default Layout
