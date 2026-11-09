import type { Metadata } from "next"
import type * as React from "react"
import { GatewayShell } from "@/components/gateway-shell"
import "./globals.css"

export const metadata: Metadata = {
  title: "OT Gateway",
  description: "The gateway's devices, points, messages and settings"
}

const RootLayout = ({ children }: { readonly children: React.ReactNode }) => (
  <html lang="en">
    <body className="min-h-dvh">
      <GatewayShell>{children}</GatewayShell>
    </body>
  </html>
)

export default RootLayout
