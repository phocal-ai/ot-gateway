# @ot-gateway/simulator

Simulated devices for tests and demos.

- `makeSimulatorDriver(device)` builds a `Driver` from a `simulator` device config
- Waveforms: `sine`, `ramp`, `daily` (a counter of the day so far that resets at local midnight), `constant`, driven by Effect's `Clock`, so `TestClock` controls them

Part of [OT Gateway](../../README.md).
