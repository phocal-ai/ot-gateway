# @ot-gateway/core

The protocol-neutral heart of OT Gateway.

- `GatewayConfig`, `Device` and point schemas (Effect Schema, JSON in and out)
- `Driver` interface every protocol implements
- `Publisher` service, with `ConsolePublisher` and an in-memory publisher for tests
- `applyScaling` and `exceedsDeadband` normalization
- Topic helpers for `site/building/device/point`, `$meta` and the gateway health topic
- `runDevice`: the read → scale → deadband → publish loop. A read that fails in transport (`timeout`, `connection`, `invalid-response`) is retried up to 4 times within the cycle with jittered backoff; a device that refused the read (`protocol`) or a `configuration` error is not, since it would only refuse again; a cycle that hangs past the device's `cycleTimeoutMs` (read or publish) is abandoned, counted as `timed_out` and reported as `cycle-timeout` in the health registry; `$meta` is retried each cycle until published. A message the broker refuses (not authorized, too large) is counted, logged once per topic and skipped, so it never holds up the device's other points. A value that is NaN or infinite (also after scaling) is a point read failure: counted, logged once until the point reads a number again, and never published
- `superviseDevice`: runs one device's pipeline and restarts it with exponential backoff (up to 5 minutes) when it dies on a defect, so a bug in one driver never stops the other devices; counted in `ot_gateway_device_restarts_total` and reported as `crashed` in the health registry
- Lasting failures are logged on transition: a device's read failure or hang when it starts or its reason changes, a broker outage once per device, and one line each when they end; every failed cycle is still counted
- Health (`Health.ts`): `HealthRegistry` (per-device status, written by `runDevice`), online/offline payloads, and `runHealthReporter`, which refreshes the retained health message
- The command guard (`Command.ts`): checks a command from `…/$set` (live, writable, type, `limits`), unscales it, writes it once with a deadline and answers it; `DriverRegistry` holds the drivers of the running devices
- `MemoryNetwork`: an in-memory TCP and UDP network implementing Effect's sockets, with crashes, partitions and datagram loss, for whole-gateway simulations; `Network` is how drivers and the MQTT publisher take one
- `describeSocketError` for readable socket failures in protocol clients

Part of [OT Gateway](../../README.md).
