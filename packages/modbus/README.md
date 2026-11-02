# @plenum/modbus

Effect-native Modbus TCP, implemented in-house.

- **Codec** (`Frame.ts`): pure MBAP/PDU encoding and decoding. A response must come from the requested unit (or unit 0 or 255, which some devices answer with whatever was asked), repeat the request's function code (or carry it with the high bit set, for an exception) and carry exactly the requested number of registers or bits; anything else is a `ModbusFrameError`, never padded values.
  - Reads: FC 01–04, coils, discrete inputs, holding and input registers.
  - Exception responses.
  - Stream framing: `takeFrame` splits a TCP byte stream into frames.
  - Values: `int16` to `float32`, high word first.
- **Planner** (`Plan.ts`): groups a device's points into as few requests as the protocol allows (125 registers or 2,000 bits per request). It only merges adjacent addresses unless `maxGap` allows more.
- **Client** (`Client.ts`): one connection per device, opened on first use.
  - Requests go out one at a time, with a request timeout (default 2 s).
  - A reader fiber per connection takes every frame off the stream. A response is paired with its request by transaction ID; stale and unsolicited frames are dropped, and stray bytes are discarded before the next request goes out.
  - A timeout, socket error or unreadable frame drops the connection, and the next request reconnects.
  - A connection the device closes while idle is noticed at once, and the next request dials again instead of waiting out the timeout on a dead socket.
  - Devices that close the connection after every response work: a request on a reused connection that closes before any byte of the response arrived is sent once more on a new connection. Each reconnect shows in `plenum_driver_connects_total`.
  - Takes an `effect/socket` `Socket`, so tests can supply their own.
- **Driver** (`Driver.ts`): `makeModbusDriver(device)` turns a `modbus-tcp` config into a `Driver`. If the device refuses one block (a Modbus exception), only that block's points are lost. Timeouts and connection problems fail the whole read.
  - A refusal is counted every time, but logged only when the block starts being refused and when it reads again, so a wrong address does not log on every cycle.
  - Transient exceptions (05 acknowledge, 06 busy, 0A and 0B gateway) are retried twice within the read. Permanent ones (01 illegal function, 02 illegal address, 03 illegal value) are not: asking again gets the same answer.
- **Simulator** (`Simulator.ts`): a real Modbus TCP server over an in-memory register bank (`serveModbus`, `setPointValue`). It answers like a strict device, and `SimulatorControl` can make it silent to test timeouts.

Metrics: `plenum_driver_requests_total{outcome}`, `plenum_driver_connects_total{outcome}` and `plenum_driver_refusals_total{exception}`. The driver adds no span per request; the cycle span carries `plenum.requests` and `plenum.refused`.

Not yet: writes (v0.4, with the command guard) and word-swapped 32-bit values.

Part of [Plenum](../../README.md).
