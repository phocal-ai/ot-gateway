import { HomeLayout } from "fumadocs-ui/layouts/home"
import type * as React from "react"
import { baseOptions } from "@/lib/layout.shared.tsx"

const Layout = ({ children }: { readonly children: React.ReactNode }) => (
  <HomeLayout {...baseOptions()}>{children}</HomeLayout>
)

export default Layout
