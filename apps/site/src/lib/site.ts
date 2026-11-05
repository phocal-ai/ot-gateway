import { repository } from "@/content/docs.ts"

export const site = {
  title: "OT Gateway",
  description:
    "An open-source edge gateway for buildings: Modbus TCP and BACnet/IP in, MQTT 5 out, safe commands back. Runs unattended on a Raspberry Pi.",
  /** The production address; Vercel sets VERCEL_PROJECT_PRODUCTION_URL at build time. */
  url: process.env["VERCEL_PROJECT_PRODUCTION_URL"]
    ? `https://${process.env["VERCEL_PROJECT_PRODUCTION_URL"]}`
    : "http://localhost:3001",
  repository
} as const
