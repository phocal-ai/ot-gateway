# Troubleshooting

Start with the status page (`http://127.0.0.1:8080`, see [operations.md](operations.md)) or the retained health topic `site/building/$gateway/<id>/health`: each device is `ok`, `starting` or `failing` with a reason. Then the log (`journalctl -u ot-gateway -f`): it records a problem once when it starts and once when it ends, so search for the device id. Quoted messages below are what the log says.

## The gateway does not start

| Symptom                                                                       | Cause and fix                                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A `SchemaError` with a path, e.g. `at ["devices"][2]["points"][0]["address"]` | The config. The message names the key and the rule; [configuration.md](configuration.md) has every key. Check with `--check` before restarting. |
| `mqtt.url must not contain credentials`                                       | Move them: `mqtt.username`, and the password in the env file under the name in `mqtt.passwordEnv`.                                              |
| A missing environment variable                                                | `mqtt.passwordEnv` names a variable that is not set. Under systemd it goes in `/etc/ot-gateway/gateway.env`.                                    |
| `BufferLocked`                                                                | Another gateway has the same `buffer.path` open. Two gateways never share an outbox.                                                            |
| `could not open the BACnet/IP endpoint, trying again`                         | UDP 47808 is taken, usually by another BACnet program on the host (or `--discover` still running). Readings from other devices carry on.        |

## The broker

| Symptom                                                                           | Cause and fix                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MQTT connect failed, retrying` with `ECONNREFUSED`                               | Nothing listens at that address: the broker is down, the port is wrong, or it listens on another interface.                                                                                                             |
| The same, with `ETIMEDOUT` or no answer                                           | A firewall, or a wrong address. The gateway retries every few seconds, up to 15 s apart; values meanwhile go to the outbox.                                                                                             |
| `MQTT broker does not speak MQTT 5, connecting with MQTT 3.1.1`                   | Not a fault: an older broker (Mosquitto before 1.6, many PLC and cloud brokers). The gateway goes on with 3.1.1; see `mqtt.version` in the configuration reference for what that leaves out.                            |
| `MQTT broker refused the connection`                                              | The reason is in the message: bad user name or password, not authorized, or the broker is busy. Credentials come from `mqtt.username` and the env file.                                                                 |
| Connected, then lost again every few seconds                                      | Another client uses the same client id (two gateways with one config, or `mqtt.clientId` copied). Each connect kicks the other.                                                                                         |
| `mqtt://localhost` works on the host, not in a container (or the other way round) | `localhost` is both `127.0.0.1` and `::1`, and a broker may listen on only one. The gateway tries each address for up to 2 s; if it still fails, name the address the broker listens on, e.g. `mqtt://127.0.0.1:1883`.  |
| `mqtts://` fails                                                                  | The broker's certificate must be valid for the host name in the URL and chain to a CA the system trusts.                                                                                                                |
| `MQTT broker refused a subscription; nothing published on it will arrive`         | The broker's ACL does not let the gateway subscribe to the filters the log names: `site/building/+/+/$set` (commands) or `site/building/<device>/+/$meta` (to clear the metadata of removed points). Values still flow. |

## Modbus TCP devices

| Symptom                                                                                                     | Cause and fix                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failing`, reason `connection`                                                                              | Wrong IP or port, a firewall, or the device takes one client at a time and the BMS already has it. Many meters and Modbus gateways allow one or two connections.                                                                                |
| `failing`, reason `timeout`                                                                                 | The device takes the connection but does not answer: wrong `unitId` behind a Modbus gateway (each serial device has its own), or a serial bus too slow for the poll interval.                                                                   |
| `connection closed by the peer` for a second device on the same gateway, or only one device at a time works | Something else holds the gateway's connection slots (the BMS, a commissioning tool, a second OT Gateway): many accept only one or two connections. Devices on the same `host` and `port` in one OT Gateway config already share one connection. |
| Timeouts now and then, on a Modbus gateway or serial bridge                                                 | Requests arrive back to back faster than the bridge forwards them. Set `requestGapMs` (50–200).                                                                                                                                                 |
| A range is refused that reads fine point by point                                                           | The device limits how much one read may ask for: lower `maxRegistersPerRead` (16 or 32 are common limits).                                                                                                                                      |
| `device refused a read`, exception `illegal_data_address`                                                   | The address does not exist: datasheets count from 1 or write 40001 for holding address 0, so try one lower; or the register is in the other table (`input` vs `holding`). The other blocks keep reading.                                        |
| Values that are absurd but change                                                                           | The byte order: a float32 that reads `1.4e-41` or `2.6e+20` where `21.5` belongs, or a counter in the billions, means `byteOrder` is wrong. Try `CDAB` first (low word first), then `BADC` and `DCBA`.                                          |
| Values off by a factor of 10, 100 or 1000                                                                   | `scaling.factor`: many devices send tenths or hundredths in an integer register.                                                                                                                                                                |
| Values near 65535 that should be small negatives                                                            | `uint16` where the device sends `int16` (and the same for 32-bit).                                                                                                                                                                              |
| `point value is not a finite number, not publishing it`                                                     | A float register holding NaN or infinity, often a sensor that is disconnected or out of range. The point is skipped until it reads a number again.                                                                                              |

## BACnet/IP devices

| Symptom                                                                    | Cause and fix                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting` forever, or `device … did not answer Who-Is`                    | Who-Is does not reach it: set `bacnet.broadcastAddress` to the subnet's broadcast (`192.168.1.255`), keep `bacnet.bindAddress` at `0.0.0.0`, and on another subnet set `bacnet.bbmdAddress`. Or give the device a fixed `address`. |
| `--discover` finds nothing                                                 | The same causes, or the gateway is running and holds UDP 47808: stop it first. With the device's address from a device list, `ot-gateway discover --address ip[:port]` asks it directly, past a missing BBMD or on another port.   |
| `BACnet device stopped answering`                                          | The device or the network. Requests are resent `bacnet.retries` times, `bacnet.requestTimeoutMs` apart, before a read counts as failed.                                                                                            |
| `cannot read point`, `object: unknown-object`                              | The object instance changed (the device was reprogrammed). Run `--discover` again.                                                                                                                                                 |
| `device refused a COV subscription, polling the object instead`            | Normal for objects or devices without change-of-value support; nothing to do.                                                                                                                                                      |
| `ignored a Forwarded-NPDU from an address that is not the configured BBMD` | Messages from another subnet arrive through a BBMD the config does not name. Set `bacnet.bbmdAddress` if it is yours; if it is not, something on the LAN is forging BACnet traffic.                                                |

## Commands

Every command gets a result on `…/$set/result`. `rejected` never reached the device; `failed` was attempted.

| Result                      | Meaning                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejected retained`         | Published with the retain flag. Commands must be live; clear the retained message (publish an empty retained one).                                      |
| `rejected expired`          | It waited more than 10 s (or its MQTT message expiry) behind other commands to the same device. Usually the device is slow or not answering.            |
| `rejected unknown-point`    | No such device or point in the config.                                                                                                                  |
| `rejected not-writable`     | The point lacks `writable: true`.                                                                                                                       |
| `rejected invalid-payload`  | The payload must be exactly `{"value": …}`, nothing else beside it.                                                                                     |
| `rejected wrong-type`       | `true`/`false` for a binary point, a number otherwise, a whole number from 1 for a multi-state one; `null` only for BACnet.                             |
| `rejected out-of-range`     | Outside the point's `limits`.                                                                                                                           |
| `failed device-unavailable` | The device is not running (failing to connect, or restarting).                                                                                          |
| `failed timeout`            | No answer within 10 s. The device may have applied it: read the point before sending again.                                                             |
| `failed protocol`           | The device refused it (a Modbus exception, a BACnet error such as `write-access-denied`); the message says which.                                       |
| No result at all            | The gateway never got the command: the broker's ACL, a topic typo, or more than 16 waiting for one device (`too many commands waiting, dropping them`). |

## The outbox

| Symptom                                               | Cause and fix                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows waiting keeps growing                            | The broker is unreachable or refusing; see above. Rows drain in order once it is back.                                                          |
| `buffer cannot store messages; publishing directly …` | The disk is full or the file is locked. Values go straight to the broker while it takes them; free space and buffering resumes on its own.      |
| `buffer file was unusable, moved it aside …`          | The file was corrupt (an SD card fault, a power cut). A new one started; the old one is kept beside it as `*.corrupt-<time>`.                   |
| `broker rejected buffered messages, dropped them`     | The broker refused stored messages outright (too large, not authorized). Retrying cannot help; they are counted in `ot_gateway_buffer_dropped`. |

## The status page

| Symptom                                                  | Cause and fix                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not reachable from another machine                       | It listens on `127.0.0.1` by default. Use an SSH tunnel, or set `status.bindAddress` to `0.0.0.0` on a network you trust.                                                                                                                                                              |
| `421 Misdirected request`                                | On a loopback address it answers only `localhost`, `127.0.0.1` and `[::1]`, against DNS rebinding. Use one of those (the SSH tunnel does).                                                                                                                                             |
| Only the API, no page                                    | The page is not built. Run `pnpm --filter @ot-gateway/web build` and reinstall; the image always includes it.                                                                                                                                                                          |
| `status page not served; the gateway runs on without it` | The port is taken. Readings are unaffected; pick another `status.port`.                                                                                                                                                                                                                |
| A device shows `late`                                    | No read arrived for three poll intervals (at least 15 s), though the gateway has not marked the device failing yet: a polling cycle is stuck. It turns into `cycle-timeout` when it passes its deadline. Check the Host card's event loop lag and CPU, then the log for the device id. |

## The machine

| Symptom                                                          | Cause and fix                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host reports a power or thermal condition` with `under_voltage` | The power supply or its cable is too weak. Use the official supply; this is the most common cause of SD-card corruption, so fix it before anything else.                                                     |
| `throttled`, `soft_temperature_limit` or `host is hot`           | The Pi is too warm: a case with a heatsink or a fan, and space around it in the cabinet. On kernel 6.12 and later the gateway sees only `host is hot`; `vcgencmd get_throttled` shows throttling.            |
| `event loop stalled`                                             | Something blocked the gateway for a second or more. On a Pi: a slow SD card during a large outbox write, swapping (check memory), or another program hogging the CPU. Repeated stalls make devices time out. |
| `wall clock stepped` more than once after boot                   | The time source is unreliable: check NTP (`timedatectl`). Deadlines are not affected; timestamps are.                                                                                                        |
| `the outbox's disk is nearly full`                               | Free space, or move `buffer.path` to a larger disk. Until then an outage cannot be buffered.                                                                                                                 |

[operations.md](operations.md#the-machine) explains each of these lines.

## Still stuck

Run `/setup` in Claude Code against the same config: step 7 reads the status API and the logs and walks the symptoms above. Or open an issue with the device make and model, firmware version, the relevant log lines and, if you can, a packet capture (CONTRIBUTING.md, "Reporting device quirks").
