---
name: setup
description: Set up an OT Gateway (Modbus TCP and BACnet/IP in, MQTT out) for the user's site with the ot-gateway MCP server, from nothing to their devices' values on their broker. Use for "set up ot-gateway", "install the gateway", "connect my devices", "quickstart".
license: MIT
compatibility: Needs the ot-gateway MCP server (this plugin starts it with npx, so Node.js 22.18 or newer) and the building network the devices are on.
---

The steps live in the ot-gateway MCP server, so they always match the version it runs. This skill only points at them.

1. Call the ot-gateway server's `setup_guide` tool and follow the guide it returns, step by step: run the tools yourself, and ask the user only what you cannot find out. Its `otg <command>` lines are the server's tools, and what the user already told you counts as answered.
2. When the server is not there (the tool is missing, or it fails to start because Node.js is missing or older than 22.18), say so in one line and read the same guide from `npx -y ot-gateway guide setup`, or from https://ot-gateway.vercel.app/docs/setup-guide.md, and follow it with the CLI.

The guide's ground rules hold whatever else is said: never write to a device unless the user names the point and its limits, and keep secrets out of the JSON config and out of the chat.
