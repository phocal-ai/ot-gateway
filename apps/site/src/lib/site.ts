import { repository } from "@/content/docs.ts"

export const site = {
  title: "OT Gateway",
  description:
    "Your sites' data, in your software: an open-source OT gateway that reads meters and controllers (Modbus TCP, BACnet/IP) and sends standard MQTT, set up and debugged with your AI agent, in Docker on any small computer.",
  /** The production address; Vercel sets VERCEL_PROJECT_PRODUCTION_URL at build time. */
  url: process.env["VERCEL_PROJECT_PRODUCTION_URL"]
    ? `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`
    : "http://localhost:3001",
  repository
} as const
