# Your first building

From the list of values you want to values arriving on your broker, in five steps. You need the demo running once first ([quick start](../README.md#quick-start)), so you know what success looks like.

## 1. Write down your points

Most projects start with a points list: a spreadsheet of what to read, from which device, how often. That list is all the gateway needs. For each device, note:

| You need             | Example                 | Where to find it                                    |
| -------------------- | ----------------------- | --------------------------------------------------- |
| Its protocol         | Modbus TCP or BACnet/IP | the device's data sheet or the commissioning sheet  |
| Its address          | `192.168.1.50`          | the network plan, the device's display, your router |
| How often to read it | every 5 s               | what your use case needs; meters often 5–60 s       |

And for each point:

| You need       | Modbus example                  | BACnet example         |
| -------------- | ------------------------------- | ---------------------- |
| A name         | Main meter active power         | AHU 2 supply air temp  |
| Where it lives | holding register 100, `float32` | found by `discover`    |
| Its unit       | kW                              | °C (usually found too) |

Also note the broker your values should go to: its URL (`mqtt://` or `mqtts://` with TLS), and a username and password if it needs one. No broker yet? Start with the simulated devices and `ot-gateway demo`, or run [Mosquitto](https://mosquitto.org) next to the gateway.

## 2. Let `init` write the config

In a checkout (`pnpm ot-gateway …`) or anywhere the gateway is installed (`ot-gateway …`):

```bash
pnpm ot-gateway init
```

It asks for the site and building (the first two parts of every topic, such as `vienna-hq` and `main`), the broker, and where your devices come from:

- **Find BACnet devices now:** the gateway asks the network who is there and drafts every device with its points, names and units. Nothing is written to a device, and no point is made writable.
- **A simulated device:** to see your broker receive values before any real device is connected.
- **None yet:** for Modbus devices, which you add in the next step.

It writes `ot-gateway.json` and checks it. The password is never in that file: put it in `ot-gateway.env` as `MQTT_PASSWORD=…` (or the name you chose).

## 3. Add your Modbus points

Modbus devices can't describe themselves, so their points come from your list. Add each device under `devices` in `ot-gateway.json`:

```json
{
  "protocol": "modbus-tcp",
  "id": "main-meter",
  "host": "192.168.1.50",
  "pollIntervalMs": 5000,
  "points": [
    {
      "id": "active-power",
      "name": "Main meter active power",
      "unit": "unit:KiloW",
      "table": "holding",
      "address": 100,
      "dataType": "float32"
    }
  ]
}
```

`id`s become topic segments, so they are lowercase with `-` (`main-meter`, `active-power`). Units are [QUDT](https://qudt.org) names such as `unit:KiloW`, `unit:DEG_C` or `unit:PERCENT`. [Configuration](configuration.md) has every option: scaling, byte order for meters that swap words, a deadband to send only real changes.

With a coding agent, `/setup` in Claude Code (or the prompt in [Set it up with AI](../README.md#set-it-up-with-ai)) reads a register list or data sheet and drafts these entries for you.

## 4. Check it, then run it

```bash
pnpm ot-gateway check     # every mistake, with where it is; nothing connects yet
pnpm ot-gateway run       # start the gateway
```

`check` lists every mistake with its place in the file (`["devices"][0]["points"][1]["dataType"]`) and what it expected there. `run` starts polling and sending; stop it with Ctrl-C.

## 5. See your values arrive

In a second terminal:

```bash
pnpm ot-gateway status    # every device: ok, or failing with the reason
pnpm ot-gateway watch     # every message, as it reaches your broker
```

Or open the status page at <http://localhost:8080>. A device that stays `failing` says why: `connection` (wrong address or port, a firewall, or another program holds the device's only connection), `timeout` (it connected but does not answer: often a wrong unit ID), `protocol` (the device refused the request: often a wrong register). [Troubleshooting](troubleshooting.md) goes from each reason to its fix.

## Then keep it running

Once values flow, move the gateway onto a machine that stays on in the building, so it runs unattended and restarts by itself:

- **Any Linux machine with Docker** (a mini PC, a NAS, an industrial PC, a server): [Docker Compose](operations.md#docker-compose-recommended) with the same `ot-gateway.json`.
- **A Raspberry Pi:** [from a blank SD card](raspberry-pi-install.md), about an hour the first time.
- **Without Docker:** [systemd](operations.md#systemd-without-docker).
