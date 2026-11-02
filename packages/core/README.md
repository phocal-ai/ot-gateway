# @plenum/core

The protocol-neutral heart of Plenum.

- `GatewayConfig`, `Device` and point schemas (Effect Schema, JSON in and out)
- `Driver` interface every protocol implements
- `Publisher` service, with `ConsolePublisher` and an in-memory publisher for tests
- `applyScaling` and `exceedsDeadband` normalization
- Topic helpers for `site/building/device/point`, `$meta` and the gateway health topic
- `runDevice`: the read → scale → deadband → publish loop, with retries; `$meta` is retried each cycle until published. A message the broker refuses (not authorized, too large) is counted, logged once per topic and skipped, so it never holds up the device's other points
- Health (`Health.ts`): `HealthRegistry` (per-device status, written by `runDevice`), online/offline payloads, and `runHealthReporter`, which refreshes the retained health message
- `describeSocketError` for readable socket failures in protocol clients

Part of [Plenum](../../README.md).
