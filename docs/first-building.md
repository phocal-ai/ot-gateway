# Your first building

From the list of values you want to values arriving on your broker, in five steps. For a script or an AI agent, with no questions asked, the same path is [Headless setup](headless.md). You need the demo running once first ([quick start](../README.md#quick-start)), so you know what success looks like.

## 1. Write down your points

Most projects start with a points list: a spreadsheet of what to read, from which device, how often. That list is all the gateway needs. [What the gateway needs from you](inputs.md) shows it in its smallest form, field by field. For each device, note:

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
pnpm ot-gateway init
```

With no `ot-gateway.json` in the folder, a bare `ot-gateway` in a terminal starts `init` too. It writes into this folder when the folder is empty and asks for a folder name otherwise; `init .` and `init my-building` say where.

It goes as the work goes, and Enter takes the default every time:

1. **The broker.** `mqtt://localhost:1883` is suggested, and init says whether something answers there. Then a username, if the broker needs one.
2. **The devices.** init asks the network who is there right away (BACnet Who-Is) and lists every point it found, all ticked: untick what the gateway should not read. With more than 25 points it reads them all and says so; leave out the ones you don't need later, on the status page or in `ot-gateway.json`. Untick them all to get to the other ways below. Then how often to read (5 seconds; Enter keeps it), for points the device does not send on change itself. Then it lists the points that commands could write (outputs and values, setpoints first), none ticked. For each one you tick it asks the lowest and highest value a command may set (15 to 30 is suggested for °C). Nothing is written to a device during setup.
3. **When nobody answers** (or discovery cannot run, say another BACnet program holds UDP 47808), init offers the other ways: ask one device by its address (`ip` or `ip:port`, for a device on another subnet or port), search again, a points list (Modbus, or BACnet from an EDE file; step 3 shows the columns), a simulated device to see values flow first, or none yet, to add devices on the status page.
4. **Site and building**, the first two parts of every topic. The folder's name is suggested for the site.

Then it writes the folder, shows what it found in a few lines, and asks whether to start the gateway now in this terminal (Ctrl-C stops it). Scripts and agents get the whole account instead, every file and the next commands, and with `--json` as data ([Headless setup](headless.md)).

`ot-gateway discover --points-list points.csv` writes what discovery finds as a points list instead: delete the rows you don't need and import it, as in step 3. Its rows say `publish` `sample`, every read; change that column to `change` for a point that should send only changes, or to `aggregate` with `publish_s` (`900` for 15 minutes). With `--append` it adds to a list that exists already, say one with your Modbus rows: the list keeps its rows, columns and separator, gets the columns it lacks, and rows it has already are skipped, so one list holds every device. An EDE file from the BACnet engineering tool (the semicolon CSV most of them export) imports as it is, and `ot-gateway points from-ede building.csv > points.csv` turns it into a list to trim first; objects that are not points (schedules, trend logs) are left out. [`examples/building.ede.csv`](../examples/building.ede.csv) is one. A points list is CSV (Excel's "CSV" export works, with commas or semicolons) or the same columns as JSON, one object per point: `[{"device": "Main meter", "point": "Active power", "host": "192.168.1.50", "register": 100, "type": "float32"}]` (`ot-gateway points schema --json-schema` prints its JSON Schema).

It writes `ot-gateway.json` and checks it. The password is never in that file: put it in `ot-gateway.env` as `MQTT_PASSWORD=…` (or the name you chose).

## 3. Add your Modbus points

Modbus devices can't describe themselves, so their points come from your list. The quickest way is the list itself, saved as CSV with one row per point:

| device       | point           | unit | interval_s | host         | register | table | type    | byte_order | scale | alarm |
| ------------ | --------------- | ---- | ---------- | ------------ | -------- | ----- | ------- | ---------- | ----- | ----- |
| Energy meter | Active power    | kW   | 5          | 192.168.1.50 | 100      |       | float32 | CDAB       |       |       |
| Energy meter | Energy          | kWh  | 5          | 192.168.1.50 | 102      |       | uint32  | CDAB       | 0.1   |       |
| Energy meter | Breaker tripped |      | 5          | 192.168.1.50 | 0        | coil  |         |            |       | on    |

```bash
pnpm ot-gateway points template > points.csv  # every column and example rows, to fill in (--protocol modbus or bacnet: only its columns)
pnpm ot-gateway import points.csv --dry-run    # checks the list and prints its devices (alone, without an ot-gateway.json here)
pnpm ot-gateway import points.csv              # adds the devices to ot-gateway.json (replaced in one step, the old one kept as ot-gateway.json.bak)
```

Rows with the same `device` are one device. Optional columns: `port` (502), `unit_id` (1), `table` (`holding`, `input`, `coil` or `discrete`; a coil or discrete input is always `bool`, its default, so its `type` can stay empty), `alarm` (`on` for an alarm active when the value is true or not 0, like "Breaker tripped"; `off` for one active when it is false or 0, like a normally-closed contact; EDE files and `discover` leave it empty), `name` (the name to show when `point` is an id such as `active-power`, which is otherwise shown as "Active power"), `deadband`, `offset`, and `publish` (`sample`, `aggregate` or `change`) with `publish_s` (send the latest value, or an aggregate, every so many seconds: `900` for 15 minutes). BACnet points can go in the same list with `device_instance`, `object_type` and `object_instance` instead of `host`, `register` and `type`. Units such as `kW`, `kWh`, `°C` and `%` become their QUDT names, which go out in each point's `$meta`; `import` lists each unit once with the name it becomes, and says which it kept as written. `register` is 0-based, as in the config: a data sheet's 40101 is usually holding register 100. A mistake names its line, and nothing is written until the whole list makes a valid config. [`examples/points.csv`](../examples/points.csv) has an energy meter, a PV inverter and a heat pump. `ot-gateway points schema` prints every column with its allowed values (`--json` for scripts and agents, `--brief --json` for one short line per column); `import` names the columns it does not know and ignores them.

### Not sure of a register's type or byte order?

Read it once and see every way it can be read:

```bash
pnpm ot-gateway probe 192.168.1.50 100                # holding registers 100 and 101 of unit 1
pnpm ot-gateway probe 192.168.1.50 0 --table input --count 4 --unit-id 2   # 64-bit types too, another unit
```

It prints the registers in hex and decimal, then each type (`int16` to `float64`) in each byte order with its value, as a point with those settings would publish it before `scale`. NaN, infinite and implausible values (a float of `1.4e-41` or `2.6e+20`, the mark of a wrong word order) are marked, and the likeliest reading is pointed out, with a points list row to copy. Pick the line whose value matches the data sheet or the device's display, and write its `type` and `byte_order`. `probe` only reads, one request, and never writes; the address is 0-based as the list's `register`, and a refusal names the Modbus exception (`illegal data address` for a register the device does not have). `--json` gives the same for scripts and agents. Some devices take one Modbus TCP connection at a time: while a gateway polls one, `probe` may be refused or time out, so probe before adding the device, or stop the gateway for a moment.

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
pnpm ot-gateway read      # every point read once, to see the devices answer; nothing is published
pnpm ot-gateway run       # start the gateway
```

`check` lists every mistake with its place in the file (`["devices"][0]["points"][1]["dataType"]`) and what it expected there. `read` asks each device once through the gateway's own drivers and prints a line per point, its value and unit or why it failed, then exits (with 1 when a point failed): `read <device>` or `read <device>/<point>` for fewer, `--json` for scripts. It needs no broker, and it only reads. `run` starts polling and sending; stop it with Ctrl-C.

## 5. See your values arrive

In a second terminal:

```bash
pnpm ot-gateway status    # every device: ok, or failing with the reason
pnpm ot-gateway watch     # every message, as it reaches your broker
```

Or open the status page at <http://localhost:8080>. A device that stays `failing` says why: `connection` (wrong address or port, a firewall, or another program holds the device's only connection), `timeout` (it connected but does not answer: often a wrong unit ID), `protocol` (the device refused the request: often a wrong register, or, with `gateway_target_failed_to_respond`, a wrong unit ID behind a Modbus gateway). [Troubleshooting](troubleshooting.md) goes from each reason to its fix.

## Then keep it running

Once values flow, move the gateway onto a machine that stays on in the building, so it runs unattended and restarts by itself:

- **Any Linux machine with Docker** (a mini PC, a NAS, an industrial PC, a server): [Docker Compose](operations.md#docker-compose-recommended) with the same `ot-gateway.json`.
- **A Raspberry Pi:** [from a blank SD card](raspberry-pi-install.md), about an hour the first time.
- **Without Docker:** [systemd](operations.md#systemd-without-docker).
