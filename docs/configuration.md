# Configuration reference

A gateway is one JSON document, by default `ot-gateway.json` (the path is `main.ts`'s argument). The schema is [`packages/core/src/Config.ts`](../packages/core/src/Config.ts) and [`Point.ts`](../packages/core/src/Point.ts); this page lists every key, and a test (`packages/core/test/ConfigDocs.test.ts`) fails when a key is added to the schema without a row here, or a row outlives its key.

Decoding is strict. A key the schema does not know (a typo) fails the start with its path, as do duplicate ids, values out of range and a JSON syntax error (with its position). Check a config without connecting to anything:

```bash
node apps/gateway/src/main.ts --check ot-gateway.json
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
| `history`          | object       | none     | Every read kept on the device; see [history](#history). The status page charts it.                          |
| `status`           | object       | none     | The local status page; see [status](#status). Without it, nothing is served.                                |
| `bacnet`           | object       | defaults | The gateway's BACnet/IP endpoint, shared by every BACnet device; see [bacnet](#bacnet).                     |
| `devices`          | array        | required | Modbus TCP, BACnet/IP and simulated devices, ids unique; may be empty.                                      |

## mqtt

| Key           | Type                       | Default                 | Meaning                                                                                                                           |
| ------------- | -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `url`         | string                     | required                | `mqtts://host:port` (TLS) or `mqtt://host:port`. No credentials in it: they would be printed and logged with it.                  |
| `clientId`    | string, ≤ 1024             | `ot-gateway-<hostname>` | The MQTT client identifier. Two gateways with the same one keep disconnecting each other.                                         |
| `username`    | string, ≤ 1024             | none                    | Broker username.                                                                                                                  |
| `passwordEnv` | string                     | none                    | Name of the environment variable holding the password (`/etc/ot-gateway/gateway.env` under systemd). Never put the password here. |
| `version`     | `"auto"`, `"5"`, `"3.1.1"` | `"auto"`                | The MQTT spoken. `auto` uses MQTT 5 and falls back to 3.1.1 when the broker refuses 5; see below for what 3.1.1 leaves out.       |

A public test broker (`broker.hivemq.com`, `broker.emqx.io`, `test.mosquitto.org`, `mqtt.eclipseprojects.io`) lets anyone read and write every topic, so a config that names one may only have devices on this machine, which are simulated: a device in a building on one is refused, by `check` and at start-up. `ot-gateway demo --public` uses one this way.

Under MQTT 3.1.1 everything works, with less help from the broker: it announces no limits (packet size, inflight messages), command results carry no correlation data, a command's message expiry is not known (its age is limited by `maxAge` alone), and a command published with the retain flag is recognized as retained only when the gateway reconnects. Prefer MQTT 5 where the broker has it; `ot-gateway broker` says which one was agreed.

A password over `mqtt://` is sent in clear text, so unless the broker is on the same machine (`localhost`, `127.0.0.0/8`, `::1`) the gateway warns about it at start-up and in `--check`: use `mqtts://`.

The session is clean: nothing sent while the gateway was offline is delivered later, commands included.

## buffer

| Key       | Type   | Default  | Meaning                                                                                                                   |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `path`    | string | required | The SQLite file. Its directory is created if missing. Put it on persistent storage (`/var/lib/ot-gateway` under systemd). |
| `maxRows` | ≥ 1    | 1000000  | Rows kept while the broker is away; beyond that the oldest are dropped and counted in `ot_gateway_buffer_dropped`.        |

## history

Every read, whatever the point's publish mode, kept on the gateway for the status page's charts and `GET /api/history`. It does not go to the broker.

| Key             | Type   | Default  | Meaning                                                                                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `path`          | string | required | The SQLite file, apart from the buffer's. Its directory is created if missing. Put it on persistent storage (`/var/lib/ot-gateway`). |
| `retentionDays` | 1–30   | 7        | Days of per-minute minimum, maximum and average kept. Every single read is kept for the last day.                                    |

Reads are written in batches every 5 s. Size it at about 40 bytes per read for the last day plus 50 bytes per point and minute: 200 points read every 5 s take about 150 MB for the day of reads and 15 MB per week of minutes. A file that cannot be opened leaves the gateway running without history (`ot_gateway_history_disabled` is 1, and the log says why); a corrupt one is moved aside and a new one started.

`GET /api/history?device=heat-pump&point=flow-temp` returns the last hour in about 300 buckets of `{ t, min, max, avg, count }`; `from` and `to` (Unix ms) and `buckets` (at most 2,000) choose another range. Within the last day the buckets come from every read, beyond it from the minutes.

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

| Key                   | Type          | Default    | Meaning                                                                                                                                                          |
| --------------------- | ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`            | `modbus-tcp`  | required   |                                                                                                                                                                  |
| `id`                  | slug          | required   | Third topic level.                                                                                                                                               |
| `host`                | string        | required   | IP address or host name.                                                                                                                                         |
| `port`                | 1–65535       | 502        |                                                                                                                                                                  |
| `unitId`              | 0–255         | 1          | MBAP unit identifier: 1 or 255 for a plain TCP device, the slave id behind a Modbus gateway.                                                                     |
| `pollIntervalMs`      | 100–86400000  | 5000       | How often the device is read.                                                                                                                                    |
| `cycleTimeoutMs`      | 1000–86400000 | see below  | How long one cycle (read with retries, then publish) may take before it is abandoned as hung.                                                                    |
| `publish`             | object        | every read | How the device's points are sent: [publish](#publish). A point's own `publish` or `deadband` overrides it.                                                       |
| `requestGapMs`        | 0–10000       | 0          | Minimum pause after each request before the next one. Slow Modbus gateways and serial bridges drop requests sent back to back; 50–200 ms helps.                  |
| `maxRegistersPerRead` | 1–125         | 125        | Most registers in one read. Lower it for a device that refuses long reads (`illegal_data_value` or `illegal_data_address` on a range that reads fine in pieces). |
| `maxBitsPerRead`      | 1–2000        | 2000       | Most coils or discrete inputs in one read.                                                                                                                       |
| `points`              | array         | required   | [Modbus points](#modbus-points), at least one, ids unique.                                                                                                       |

`cycleTimeoutMs` defaults to twice `pollIntervalMs`, and at least `pollIntervalMs` plus 30 s.

**Several devices behind one Modbus gateway** (RS-485 meters behind an RTU-to-TCP converter, say) are configured as one device each, with the gateway's `host` and `port` and each meter's own `unitId`. Devices with the same `host` and `port` share one TCP connection, since many gateways accept only one or two, and their requests take turns, as the serial bus needs anyway. The largest `requestGapMs` among them applies to all of them. A meter that stops answering delays the others by up to the request timeout (2 s) per cycle, but does not cost them the connection; the gateway reconnects only when none of them answers.

## BACnet/IP devices

`"protocol": "bacnet-ip"`.

| Key              | Type              | Default    | Meaning                                                                                                                                              |
| ---------------- | ----------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`       | `bacnet-ip`       | required   |                                                                                                                                                      |
| `id`             | slug              | required   | Third topic level.                                                                                                                                   |
| `deviceInstance` | 0–4194302         | required   | The device object's instance.                                                                                                                        |
| `address`        | `ip` or `ip:port` | none       | Fixed address. Without it the device is found by broadcasting Who-Is. Required when any point is writable, so a spoofed I-Am cannot redirect writes. |
| `cov`            | boolean           | `true`     | Subscribe to change-of-value notifications where the device supports them, and poll only what they do not cover.                                     |
| `pollIntervalMs` | 100–86400000      | 5000       |                                                                                                                                                      |
| `cycleTimeoutMs` | 1000–86400000     | see above  |                                                                                                                                                      |
| `publish`        | object            | every read |                                                                                                                                                      |
| `points`         | array             | required   | [BACnet points](#bacnet-points).                                                                                                                     |

`node apps/gateway/src/main.ts --discover ot-gateway.json` finds the devices on the network and prints their entries, read-only. An entry's `address` is where the device's answer came from: before any point of the device becomes writable, confirm it against a source you trust (commissioning sheet, device display, DHCP reservation). When more than one address answers for the same instance (two devices may share the instance, or one device answers on several addresses), `--discover` names them all on stderr and drafts that device without `address` or points: take its address from that source, using the list only to see which hosts to check. A device already in the config with an `address` is read at that address, and its entry in the draft, under its config id, holds only the objects it has no point for yet, to merge into its `points`.

## Simulated devices

`"protocol": "simulator"`: waveforms, for demos and tests.

| Key              | Type          | Default    | Meaning                                |
| ---------------- | ------------- | ---------- | -------------------------------------- |
| `protocol`       | `simulator`   | required   |                                        |
| `id`             | slug          | required   |                                        |
| `pollIntervalMs` | 100–86400000  | 5000       |                                        |
| `cycleTimeoutMs` | 1000–86400000 | see above  |                                        |
| `publish`        | object        | every read |                                        |
| `points`         | array         | required   | [Simulated points](#simulated-points). |

## Points

Every point, whatever its protocol, has these keys.

| Key         | Type    | Default  | Meaning                                                                                                                   |
| ----------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`        | slug    | required | Fourth topic level.                                                                                                       |
| `name`      | string  | required | Human-readable, published on the retained `…/$meta` topic.                                                                |
| `unit`      | string  | none     | A QUDT unit, `unit:DEG_C`, `unit:KiloW`, `unit:KiloW-HR`, `unit:PERCENT`; published with each value.                      |
| `writable`  | boolean | `false`  | Takes commands on `…/$set`. See the README, "Commands".                                                                   |
| `limits`    | object  | none     | `{ "min", "max" }` in engineering units, `min` ≤ `max`; required on every writable numeric point.                         |
| `deadband`  | ≥ 0     | none     | Short for `"publish": { "mode": "change", "deadband": … }`. Not together with `publish`.                                  |
| `publish`   | object  | device's | This point's [publish](#publish) mode, instead of its device's.                                                           |
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

## publish

How a point's values go out. Reading (`pollIntervalMs`) and sending are separate: a device read every 5 s can send each read, the latest value once a minute, or a 15-minute average. Set it on a device for all its points, or on a point.

| Key            | Type                            | Default               | Meaning                                                                                                                       |
| -------------- | ------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | `sample`, `aggregate`, `change` | `sample`              | `sample`: the value as read. `aggregate`: a summary of each window. `change`: only when it changes.                           |
| `intervalMs`   | 1000–86400000, divides a day    | every read (`sample`) | `sample`: send the latest value once per interval. `aggregate`: the window, required. At least the device's `pollIntervalMs`. |
| `deadband`     | ≥ 0                             | any change            | `change` only: minimum change, after scaling, before a value is sent again.                                                   |
| `maxSilenceMs` | 1000–86400000                   | none                  | `change` only: send the value again after this long without a change, so a consumer can tell a quiet point from a gone one.   |

Windows line up with the clock in UTC: a 15-minute window (`900000`) closes at :00, :15, :30 and :45 on every gateway, so its values line up with meter intervals and with each other. That is why `intervalMs` must divide a day (60000, 300000, 900000, 3600000, …).

An aggregate message replaces the plain `{ value, unit, ts }`:

```json
{
  "value": 21.4,
  "min": 20.9,
  "max": 22.1,
  "avg": 21.4,
  "last": 21.7,
  "count": 180,
  "from": 1762344000000,
  "to": 1762344900000,
  "ts": 1762344900000,
  "unit": "unit:DEG_C"
}
```

- `avg` is time-weighted: each value counts for as long as it held, so irregular reads (BACnet change-of-value pushes, a retry) do not skew it. `value` is the average, so a consumer that reads only `value` gets a sensible number.
- A boolean has `avg` as the share of the window it was true (0 to 1), `value` and `last` as its last state, and no `min` or `max`.
- `count` is the number of reads. A window with no read is sent with `count: 0` when the value held through it (a change-of-value point that stayed put) and the device answers; while the device does not, nothing is sent, and the outage does not count towards the next average.
- The first window after a start is `"partial": true`, with `from` at the first read.

**What it costs.** Every read is the most traffic: points × 3600 / interval in seconds is the messages per hour, and the [buffer](#buffer) holds `maxRows` of them through a broker outage. 200 points read every 5 s fill a million rows in about 7 hours; as 15-minute aggregates, in about 7 weeks.

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
