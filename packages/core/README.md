# @plenum/core

The protocol-neutral heart of Plenum.

- `GatewayConfig`, `Device` and point schemas (Effect Schema, JSON in and out)
- `Driver` interface every protocol implements
- `Publisher` service, with `ConsolePublisher` and an in-memory publisher for tests
- `applyScaling` and `exceedsDeadband` normalization
- Topic helpers for `site/building/device/point` and `$meta`
- `runDevice`: the read → scale → deadband → publish loop, with retries

Part of [Plenum](../../README.md).
