import { RootProvider } from "fumadocs-ui/provider/next"
import type { Metadata } from "next"
import type * as React from "react"
import StaticSearchDialog from "@/components/search.tsx"
import { site } from "@/lib/site.ts"
import "./globals.css"

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: `%s | ${site.title}` },
  description: site.description,
  openGraph: { siteName: site.title, type: "website" }
}

const RootLayout = ({ children }: { readonly children: React.ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <body className="flex min-h-dvh flex-col antialiased">
      <RootProvider search={{ SearchDialog: StaticSearchDialog }}>{children}</RootProvider>
    </body>
  </html>
)

export default RootLayout
