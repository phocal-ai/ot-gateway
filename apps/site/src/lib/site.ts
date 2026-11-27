import { repository } from "@/content/docs.ts"

export const site = {
  title: "OT Gateway",
  description:
    "Your sites' data, in your software: an open-source OT gateway that reads meters and controllers (Modbus TCP, BACnet/IP) and sends standard MQTT, set up and debugged with your AI agent, in Docker on any small computer.",
  /** The production address; Vercel sets VERCEL_PROJECT_PRODUCTION_URL at build time. */
  url: process.env["VERCEL_PROJECT_PRODUCTION_URL"]
    ? `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`
    : "http://localhost:3001",
  /**
   * The address an agent outside this machine can read: the production one, also in a local build, so the
   * prompts that point agents at a page's Markdown never point at localhost.
   */
  publicUrl: `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"] ?? "ot-gateway.vercel.app"}`,
  repository
} as const
