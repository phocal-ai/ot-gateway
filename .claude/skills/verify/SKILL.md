---
name: verify
description: Run OT Gateway's demo and check a change end to end (devices read, values reach the broker, the status page and the CLI agree). Use after a change to drivers, the pipeline, MQTT, the buffer, the HTTP API, the CLI or the status page, or for "verify", "does it work", "check it in the real app".
---

Unit tests use our own broker and simulators; this checks the running gateway as a person would see it.

## Start

1. Run `pnpm demo` in the background. It builds the status page (cached), then runs the gateway, a test MQTT broker on port 1883 and three simulated devices (a simulator, Modbus TCP and BACnet/IP) in one process.
2. Wait until `curl -sf http://localhost:8080/api/status` succeeds (a few seconds; give up after 60 and report the log).

## Check

- `pnpm -s ot-gateway status --url http://localhost:8080` exits 0 and lists `pv-inverter`, `energy-meter` and `heat-pump` as `ok`, the broker connected and the buffer near empty.
- `pnpm -s ot-gateway messages --url http://localhost:8080` shows every point's topic with "reached the broker" equal to "sent", plus the retained `$meta` and `$gateway/main/health` topics.
- `pnpm -s ot-gateway events --url http://localhost:8080 --since 5m` shows no failure you did not cause.
- Exercise the change itself: the command, API endpoint, topic or page it touches. For a status page change, open http://localhost:8080 with the Chrome tools, use the flow and take a screenshot.
- For a failure path (a device or the broker going away), say which one you could not reach from the demo and point at the test or `scripts/soak.sh` run that covers it.

## Finish

Stop the demo (`pkill -f "main.ts demo"`). Report the steps you ran, what each showed, and anything that did not match, with the command output.
