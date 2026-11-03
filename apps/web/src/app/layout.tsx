import type { Metadata } from "next"
import type * as React from "react"
import "./globals.css"

export const metadata: Metadata = {
  title: "Plenum gateway",
  description: "The gateway's devices, values and commands"
}

const RootLayout = ({ children }: { readonly children: React.ReactNode }) => (
  <html lang="en">
    <body className="min-h-dvh">{children}</body>
  </html>
)

export default RootLayout
