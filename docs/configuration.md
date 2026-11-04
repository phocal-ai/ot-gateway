# Configuration reference

A gateway is one JSON document, by default `plenum.json` (the path is `main.ts`'s argument). The schema is [`packages/core/src/Config.ts`](../packages/core/src/Config.ts) and [`Point.ts`](../packages/core/src/Point.ts); this page lists every key, and a test (`packages/core/test/ConfigDocs.test.ts`) fails when a key is added to the schema without a row here, or a row outlives its key.

Decoding is strict. A key the schema does not know (a typo) fails the start with its path, as do duplicate ids, values out of range and a JSON syntax error (with its position). Check a config without connecting to anything:

```bash
node apps/gateway/src/main.ts --check plenum.json
```

Ids (`site`, `building`, gateway, device and point ids) are slugs: lowercase letters, digits, `-` and `_`, starting with a letter or digit, at most 64 characters. They become MQTT topic levels, `site/building/device/point`.

Durations are milliseconds unless the key says seconds.

## Gateway

The top level of the document.

| Key                | Type         | Default  | Meaning                                                                                                     |
| ------------------ | ------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `site`             | slug         | required | First topic level.                                                                                          |
| `building`         | slug         | required | Second topic level.                                                                                         |
| `id`               | slug         | `main`   | This gateway within the building. Its health topic is `site/building/$gateway/<id>/health`.                 |
| `healthIntervalMs` | 1000–3600000 | 60000    | How often the retained health message is refreshed.                                                         |
| `mqtt`             | object       | required | The broker; see [mqtt](#mqtt).                                                                              |
| `buffer`           | object       | none     | Store-and-forward outbox; see [buffer](#buffer). Without it, values read while the broker is down are lost. |
| `status`           | object       | none     | The local status page; see [status](#status). Without it, nothing is served.                                |
| `bacnet`           | object       | defaults | The gateway's BACnet/IP endpoint, shared by every BACnet device; see [bacnet](#bacnet).                     |
| `devices`          | array        | required | Modbus TCP, BACnet/IP and simulated devices, ids unique; may be empty.                                      |

## mqtt

| Key           | Type           | Default             | Meaning                                                                                                                       |
| ------------- | -------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `url`         | string         | required            | `mqtt://host:port` or `mqtts://host:port` (TLS). No credentials in it: they would be printed and logged with it.              |
| `clientId`    | string, ≤ 1024 | `plenum-<hostname>` | The MQTT client identifier. Two gateways with the same one keep disconnecting each other.                                     |
| `username`    | string, ≤ 1024 | none                | Broker username.                                                                                                              |
| `passwordEnv` | string         | none                | Name of the environment variable holding the password (`/etc/plenum/gateway.env` under systemd). Never put the password here. |

The session is clean: nothing sent while the gateway was offline is delivered later, commands included.

## buffer

| Key       | Type   | Default  | Meaning                                                                                                               |
| --------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `path`    | string | required | The SQLite file. Its directory is created if missing. Put it on persistent storage (`/var/lib/plenum` under systemd). |
| `maxRows` | ≥ 1    | 1000000  | Rows kept while the broker is away; beyond that the oldest are dropped and counted in `plenum_buffer_dropped`.        |

## status

| Key           | Type    | Default        | Meaning                                                                                                                                                 |
| ------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindAddress` | IPv4    | `127.0.0.1`    | Where the page listens. On a loopback address it answers only loopback host names. `0.0.0.0` opens it to the network: it is read-only but has no login. |
| `port`        | 1–65535 | 8080           | The page and `GET /api/status`.                                                                                                                         |
| `webRoot`     | path    | `apps/web/out` | The built page. Without one, only the API is served.                                                                                                    |

## bacnet

One UDP socket serves every BACnet device. Present with defaults even when the block is left out.

| Key                  | Type              | Default           | Meaning                                                                                                                                                      |
| -------------------- | ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bindAddress`        | IPv4              | `0.0.0.0`         | Local address. On Linux a socket bound to one address does not receive broadcasts, so devices answering Who-Is by broadcast are found only with the default. |
| `port`               | 1–65535           | 47808             | The gateway's UDP port. Devices broadcast I-Am to 47808; on another port only devices that answer directly are heard.                                        |
| `broadcastAddress`   | `ip` or `ip:port` | `255.255.255.255` | Where Who-Is goes. Set the subnet's broadcast (`192.168.1.255`): the default leaves through one interface only.                                              |
| `bbmdAddress`        | `ip` or `ip:port` | none              | The subnet's BBMD. Only it may forward messages from other subnets; without it, a forwarded message counts only if it comes from the device it names.        |
| `requestTimeoutMs`   | 100–60000         | 3000              | How long to wait for an answer before resending.                                                                                                             |
| `retries`            | 0–10              | 2                 | Resends after a timeout. A request's whole deadline is `requestTimeoutMs × (retries + 1)`.                                                                   |
| `covLifetimeSeconds` | 10–86400          | 300               | Lifetime requested for change-of-value subscriptions, renewed at half of it.                                                                                 |

## Modbus TCP devices

`"protocol": "modbus-tcp"`.

| Key                   | Type          | Default   | Meaning                                                                                                                                                          |
| --------------------- | ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`            | `modbus-tcp`  | required  |                                                                                                                                                                  |
| `id`                  | slug          | required  | Third topic level.                                                                                                                                               |
| `host`                | string        | required  | IP address or host name.                                                                                                                                         |
| `port`                | 1–65535       | 502       |                                                                                                                                                                  |
| `unitId`              | 0–255         | 1         | MBAP unit identifier: 1 or 255 for a plain TCP device, the slave id behind a Modbus gateway.                                                                     |
| `pollIntervalMs`      | 100–86400000  | 5000      | How often the device is read.                                                                                                                                    |
| `cycleTimeoutMs`      | 1000–86400000 | see below | How long one cycle (read with retries, then publish) may take before it is abandoned as hung.                                                                    |
| `requestGapMs`        | 0–10000       | 0         | Minimum pause after each request before the next one. Slow Modbus gateways and serial bridges drop requests sent back to back; 50–200 ms helps.                  |
| `maxRegistersPerRead` | 1–125         | 125       | Most registers in one read. Lower it for a device that refuses long reads (`illegal_data_value` or `illegal_data_address` on a range that reads fine in pieces). |
| `maxBitsPerRead`      | 1–2000        | 2000      | Most coils or discrete inputs in one read.                                                                                                                       |
| `points`              | array         | required  | [Modbus points](#modbus-points), at least one, ids unique.                                                                                                       |

`cycleTimeoutMs` defaults to twice `pollIntervalMs`, and at least `pollIntervalMs` plus 30 s.

**Several devices behind one Modbus gateway** (RS-485 meters behind an RTU-to-TCP converter, say) are configured as one device each, with the gateway's `host` and `port` and each meter's own `unitId`. Devices with the same `host` and `port` share one TCP connection, since many gateways accept only one or two, and their requests take turns, as the serial bus needs anyway. The largest `requestGapMs` among them applies to all of them. A meter that stops answering delays the others by up to the request timeout (2 s) per cycle, but does not cost them the connection; the gateway reconnects only when none of them answers.

## BACnet/IP devices

`"protocol": "bacnet-ip"`.

| Key              | Type              | Default   | Meaning                                                                                                                                              |
| ---------------- | ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`       | `bacnet-ip`       | required  |                                                                                                                                                      |
| `id`             | slug              | required  | Third topic level.                                                                                                                                   |
| `deviceInstance` | 0–4194302         | required  | The device object's instance.                                                                                                                        |
| `address`        | `ip` or `ip:port` | none      | Fixed address. Without it the device is found by broadcasting Who-Is. Required when any point is writable, so a spoofed I-Am cannot redirect writes. |
| `cov`            | boolean           | `true`    | Subscribe to change-of-value notifications where the device supports them, and poll only what they do not cover.                                     |
| `pollIntervalMs` | 100–86400000      | 5000      |                                                                                                                                                      |
| `cycleTimeoutMs` | 1000–86400000     | see above |                                                                                                                                                      |
| `points`         | array             | required  | [BACnet points](#bacnet-points).                                                                                                                     |

`node apps/gateway/src/main.ts --discover plenum.json` finds the devices on the network and prints their entries, read-only.

## Simulated devices

`"protocol": "simulator"`: waveforms, for demos and tests.

| Key              | Type          | Default   | Meaning                                |
| ---------------- | ------------- | --------- | -------------------------------------- |
| `protocol`       | `simulator`   | required  |                                        |
| `id`             | slug          | required  |                                        |
| `pollIntervalMs` | 100–86400000  | 5000      |                                        |
| `cycleTimeoutMs` | 1000–86400000 | see above |                                        |
| `points`         | array         | required  | [Simulated points](#simulated-points). |

## Points

Every point, whatever its protocol, has these keys.

| Key         | Type    | Default  | Meaning                                                                                                                   |
| ----------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`        | slug    | required | Fourth topic level.                                                                                                       |
| `name`      | string  | required | Human-readable, published on the retained `…/$meta` topic.                                                                |
| `unit`      | string  | none     | A QUDT unit, `unit:DEG_C`, `unit:KiloW`, `unit:KiloW-HR`, `unit:PERCENT`; published with each value.                      |
| `writable`  | boolean | `false`  | Takes commands on `…/$set`. See the README, "Commands".                                                                   |
| `limits`    | object  | none     | `{ "min", "max" }` in engineering units, `min` ≤ `max`; required on every writable numeric point.                         |
| `deadband`  | ≥ 0     | none     | Minimum change, after scaling, before a new value is published.                                                           |
| `scaling`   | object  | none     | `{ "factor", "offset" }`: `value = raw × factor + offset`. `factor` defaults to 1 and cannot be 0, `offset` to 0.         |
| `semantics` | object  | none     | `{ "brick": "Supply_Air_Temperature_Sensor", "haystack": ["discharge", "air", "temp", "sensor"] }`, published on `$meta`. |

## Modbus points

| Key         | Type                                                                                  | Default  | Meaning                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table`     | `holding`, `input`, `coil`, `discrete`                                                | required | FC 03, 04, 01 and 02. Only `holding` and `coil` can be written.                                                                                                                             |
| `address`   | 0–65535                                                                               | required | 0-based. Datasheets often count from 1 or write 40001 for holding address 0. A value of several registers must end by 65535.                                                                |
| `dataType`  | `int16`, `uint16`, `int32`, `uint32`, `float32`, `int64`, `uint64`, `float64`, `bool` | required | 32-bit types take two registers, 64-bit ones four. 64-bit integers are exact up to 2^53.                                                                                                    |
| `byteOrder` | `ABCD`, `CDAB`, `BADC`, `DCBA`                                                        | `ABCD`   | How a value's bytes are spread over its registers: high word first, low word first (common on meters), bytes swapped in each register, little-endian. See troubleshooting.                  |
| `bit`       | 0–15                                                                                  | none     | One bit of a holding or input register (0 is the least significant), published as `true` or `false`: a status word's flags as separate points. Needs `dataType: "bool"`; cannot be written. |

## BACnet points

| Key          | Type           | Default         | Meaning                                                                                         |
| ------------ | -------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `objectType` | name or number | required        | `analog-input`, `binary-output`, `multi-state-value`, …, or a number for proprietary types.     |
| `instance`   | 0–4194302      | required        |                                                                                                 |
| `property`   | name or number | `present-value` | The property read (and written).                                                                |
| `priority`   | 1–16, not 6    | 8               | The priority-array slot writes use (8 is manual operator); `null` as a command relinquishes it. |

A binary object's present value is published as `true` or `false`; a multi-state one as its state number (from 1).

## Simulated points

| Key             | Type                       | Default  | Meaning                    |
| --------------- | -------------------------- | -------- | -------------------------- |
| `waveform`      | `sine`, `ramp`, `constant` | required |                            |
| `min`           | number                     | required |                            |
| `max`           | number                     | required |                            |
| `periodSeconds` | number                     | 60       | One cycle of the waveform. |

## limits

| Key   | Type   | Default  | Meaning                         |
| ----- | ------ | -------- | ------------------------------- |
| `min` | number | required | Lowest value a command may set. |
| `max` | number | required | Highest, at least `min`.        |

## scaling

| Key      | Type       | Default | Meaning                         |
| -------- | ---------- | ------- | ------------------------------- |
| `factor` | number ≠ 0 | 1       | `value = raw × factor + offset` |
| `offset` | number     | 0       |                                 |

## semantics

| Key        | Type            | Default | Meaning                                              |
| ---------- | --------------- | ------- | ---------------------------------------------------- |
| `brick`    | string          | none    | A Brick class, e.g. `Supply_Air_Temperature_Sensor`. |
| `haystack` | array of string | none    | Haystack marker tags.                                |
