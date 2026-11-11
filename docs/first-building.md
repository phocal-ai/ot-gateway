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

| You need       | Modbus example                  | BACnet example             |
| -------------- | ------------------------------- | -------------------------- |
| A name         | Energy meter active power       | Heat pump flow temperature |
| Where it lives | holding register 100, `float32` | found by `discover`        |
| Its unit       | kW                              | °C (usually found too)     |

Also note the broker your values should go to: its URL (`mqtt://` or `mqtts://` with TLS), and a username and password if it needs one. No broker yet? Start with the simulated devices and `ot-gateway demo`, or run [Mosquitto](https://mosquitto.org) next to the gateway.

## 2. Let `init` write the config

In a checkout (`pnpm ot-gateway …`) or anywhere the gateway is installed (`ot-gateway …`):

```bash
pnpm ot-gateway init .
```

`.` writes into this folder; `init my-building` makes a folder for it, and `init` alone asks where.

It asks for the site and building (the first two parts of every topic, such as `site-1` and `building-a`), the broker, and where your devices come from:

- **Find BACnet devices now:** the gateway asks the network who is there and drafts every device with its points, names and units. Nothing is written to a device, and no point is made writable. `ot-gateway discover --points-list points.csv` writes the same as a points list instead: delete the rows you don't need and import it, as in step 3. With `--append` it adds to a list that exists already, say one with your Modbus rows: the list keeps its rows, columns and separator, gets the columns it lacks, and rows it has already are skipped, so one list holds every device. An EDE file from the BACnet engineering tool (the semicolon CSV most of them export) imports as it is, and `ot-gateway points from-ede building.csv > points.csv` turns it into a list to trim first; objects that are not points (schedules, trend logs) are left out. [`examples/building.ede.csv`](../examples/building.ede.csv) is one.
- **A simulated device:** to see your broker receive values before any real device is connected.
- **From a points list:** a CSV of your devices and points (step 3 shows the columns). Excel's "CSV" export works, with commas or semicolons.
- **None yet:** to add devices in the next step.

It writes `ot-gateway.json` and checks it. The password is never in that file: put it in `ot-gateway.env` as `MQTT_PASSWORD=…` (or the name you chose).

## 3. Add your Modbus points

Modbus devices can't describe themselves, so their points come from your list. The quickest way is the list itself, saved as CSV with one row per point:

| device       | point           | unit | interval_s | host         | register | table | type    | byte_order | scale |
| ------------ | --------------- | ---- | ---------- | ------------ | -------- | ----- | ------- | ---------- | ----- |
| Energy meter | Active power    | kW   | 5          | 192.168.1.50 | 100      |       | float32 | CDAB       |       |
| Energy meter | Energy          | kWh  | 5          | 192.168.1.50 | 102      |       | uint32  | CDAB       | 0.1   |
| Energy meter | Breaker tripped |      | 5          | 192.168.1.50 | 0        | coil  |         |            |       |

```bash
pnpm ot-gateway points template > points.csv  # every column and example rows, to fill in
pnpm ot-gateway import points.csv --dry-run    # checks the list and prints its devices (alone, without an ot-gateway.json here)
pnpm ot-gateway import points.csv              # adds the devices to ot-gateway.json
```

Rows with the same `device` are one device. Optional columns: `port` (502), `unit_id` (1), `table` (`holding`, `input`, `coil` or `discrete`; a coil or discrete input needs no `type`), `deadband`, `offset`, and `publish` (`sample`, `aggregate` or `change`) with `publish_s` (send the latest value, or an aggregate, every so many seconds: `900` for 15 minutes). BACnet points can go in the same list with `device_instance`, `object_type` and `object_instance` instead of `host`, `register` and `type`. Units such as `kW`, `kWh`, `°C` and `%` become their QUDT names. `register` is 0-based, as in the config: a data sheet's 40101 is usually holding register 100. A mistake names its line, and nothing is written until the whole list makes a valid config. [`examples/points.csv`](../examples/points.csv) has an energy meter, a PV inverter and a heat pump. `ot-gateway points schema` prints every column with its allowed values (`--json` for scripts and agents); `import` names the columns it does not know and ignores them.

### Meters with a profile

For a device model in the [profile library](../profiles), one row is enough: name the profile, and `*` takes all its points (or put one point's name in `point`, one row each):

| device    | point | interval_s | host         | unit_id | profile        |
| --------- | ----- | ---------- | ------------ | ------- | -------------- |
| Sub meter | \*    | 15         | 192.168.1.60 | 2       | eastron-sdm630 |

The row gives what differs per device (host, unit id, interval, what to send) and the profile gives the registers, types and units; a `byte_order`, `scale` or `unit` on the row still wins. `ot-gateway profiles list` shows the library and `ot-gateway profiles show eastron-sdm630` one profile's points. For a model that is not there, a profile can live next to the list as a draft (`profile: ./my-meter.json`, the format from `ot-gateway profiles schema`), and a reviewed one can go into the library (CONTRIBUTING.md, "Device profiles").

Or add each device by hand under `devices` in `ot-gateway.json`:

```json
{
  "protocol": "modbus-tcp",
  "id": "energy-meter",
  "host": "192.168.1.50",
  "pollIntervalMs": 5000,
  "points": [
    {
      "id": "active-power",
      "name": "Energy meter active power",
      "unit": "unit:KiloW",
      "table": "holding",
      "address": 100,
      "dataType": "float32"
    }
  ]
}
```

`id`s become topic segments, so they are lowercase with `-` (`energy-meter`, `active-power`). Units are [QUDT](https://qudt.org) names such as `unit:KiloW`, `unit:DEG_C` or `unit:PERCENT`. [Configuration](configuration.md) has every option: scaling, byte order for meters that swap words, and what to send: every read (the default), the latest per interval, 15-minute aggregates or only real changes.

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
