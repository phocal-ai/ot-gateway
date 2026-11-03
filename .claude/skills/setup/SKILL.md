---
name: setup
description: Set up a Plenum gateway from scratch in about 15 minutes. Checks Node and pnpm, shows the demo, asks a few questions, discovers BACnet devices, drafts Modbus points from a register list or datasheet, writes and validates plenum.json, runs it until values flow, and optionally installs it as a systemd service or container. Use for "/setup", "set up plenum", "install the gateway", "connect my devices", "quickstart".
---

Get the user from a fresh checkout to a gateway publishing their devices' values, in about 15 minutes and with as few questions as possible. Do the work yourself: run the commands, read the output, fix what fails. Ask only for what you cannot find out yourself, and batch questions into one `AskUserQuestion` call where you can.

Say in one line what is about to happen, then start with step 1. Keep the user posted with one short line per step, not a log dump.

## Ground rules

- **Never write to a device.** No point gets `writable: true` unless the user asks for it by name, and then only with `limits` they confirm. Discovery and test runs only read.
- **Secrets stay out of JSON.** A broker password goes in `plenum.env` as `PLENUM_MQTT_PASSWORD=…`, and the config names it with `mqtt.passwordEnv`. Never print it back.
- **The config is `plenum.json` at the repo root** (the gateway's default path). `plenum.json` and `plenum.env` are git-ignored; never commit them.
- **Only keys the schema knows.** The schema is `packages/core/src/Config.ts` and `Point.ts`, and unknown keys are errors. Don't invent options: there is no word-order or byte-swap setting, for example. If a device needs one, say so, and don't guess.
- **`sudo` and service installs** need a yes from the user in this session before you run them.

## 1. Preflight (no questions)

Run these, in parallel where you can:

- `node --version` must be 22.18 or later. If it's older or missing, stop and give the one install command for their OS: `fnm install 24` or `nvm install 24` if one is present. On a Raspberry Pi or Debian, use NodeSource: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`.
- `corepack enable` (pnpm 10 comes from `packageManager`), then `pnpm install`.
- `pnpm --filter @plenum/web build` builds the status page. If it fails on a small Pi, carry on: the gateway serves its JSON API without the page.

## 2. Demo, about 2 minutes

Skip this if the user says they've seen it. Otherwise:

1. Start `pnpm bench` in the background: a local MQTT broker plus simulated Modbus and BACnet devices.
2. Start `pnpm gateway` in the background.
3. Within about 10 s the bench prints messages like `demo-site/b1/main-meter/active-power {"value":…}`. Show three of them.
4. Mention the status page at http://127.0.0.1:8080.
5. Stop both before going on. The bench holds UDP port 47809 and TCP ports 1883 and 5020.

## 3. Questions, one round

Ask these in a single `AskUserQuestion`:

1. **Devices:** "Modbus TCP", "BACnet/IP", "Both", or "None yet (simulated)". Use multiSelect if you prefer.
2. **Broker:**
   - "My own broker": you'll ask for the URL next.
   - "Local test broker for now": uses `pnpm bench`'s broker, `mqtt://localhost:1883`.
3. **Where it will run:**
   - "This machine, for now"
   - "Raspberry Pi / Linux with systemd"
   - "Docker"

Then ask in plain text, in one message, only for what applies:

- **Site and building names**, e.g. "Vienna HQ, Building 1". You make the slugs: `vienna-hq`, `b1`.
- **Broker URL** (`mqtt://` or `mqtts://host:port`), and a username and password if it needs them.
- **Modbus:** each device's IP and unit id (often 1, or 255 for a plain TCP device), plus the register list. Accept a pasted table, a CSV, or a path to the datasheet PDF, and read it yourself.

## 4. BACnet: discover, don't ask

1. Find this machine's subnet broadcast:
   - Linux: `ip -4 -o addr show scope global` gives `brd 192.168.1.255`.
   - macOS: `ifconfig | grep broadcast`.

   If there are several interfaces, pick the one on the building network, and ask if that's unclear.

2. Write a minimal `plenum.json` with:
   - `site`, `building` and `mqtt`;
   - `"devices": []`;
   - `"bacnet": { "broadcastAddress": "<brd>" }`.
3. Run `node apps/gateway/src/main.ts --discover plenum.json`. Nothing else may hold UDP 47808 (stop the bench or another BACnet tool first). It prints progress on stderr and on stdout a draft `{ "devices": [...] }` with names, object types, instances and QUDT units, all read-only.
4. Show a short summary: device, name and point count. If there are more than about 5 devices or 50 points, ask which devices to keep. Merge them into `plenum.json`.
5. **Nothing answered?**
   - Check the broadcast address.
   - On another subnet, devices need a BBMD: ask for its address and set `bacnet.bbmdAddress`.
   - A firewall can drop UDP 47808.
   - As a last resort, ask for one device's IP and put that in `broadcastAddress` (Who-Is to one device).

## 5. Modbus: draft from the register list

For each register, write a point:

- `table`: `holding` for 4xxxx/FC03, `input` for 3xxxx/FC04, `coil` for 0xxxx/FC01, `discrete` for 1xxxx/FC02.
- `address`: **0-based.** Datasheets often list 40001-style numbers or 1-based addresses, so 40001 means holding `address: 0`. When the sheet is unclear, say which you assumed. A wrong guess shows up in step 7 as values that are off, or as exception 2 (illegal data address).
- `dataType`: `int16`, `uint16`, `int32`, `uint32`, `float32` or `bool`. 32-bit values take two registers, high word first.
- `scaling: { "factor": 0.1 }` for registers in tenths, and so on.
- `unit` in QUDT (`unit:DEG_C`, `unit:KiloW`, `unit:KiloW-HR`, `unit:PERCENT`, `unit:V`, `unit:A`, `unit:HZ`, `unit:PA`).
- `id`: a slug of the name.

Start with the 10 to 20 registers that matter (energy, power, temperatures, states), not all 300, and say that more can be added later.

## 6. Write and check the config

Fill in `plenum.json`:

- `"id": "main"`.
- `"buffer": { "path": "./plenum-buffer.sqlite" }`, so values survive broker outages.
- `"status": {}` for the status page on 127.0.0.1:8080.
- `pollIntervalMs` of 5000 to 60000 depending on what the user needs: energy meters rarely need under 15 s.
- `cov` stays at its default for BACnet.
- No simulator devices unless the user chose "None yet".

Run `node apps/gateway/src/main.ts --check plenum.json` and fix every error it reports, by path, until it prints `config ok`. Show the user that summary.

## 7. First run: values must flow

1. **Local test broker:** start `pnpm bench` in the background, with the bench reading `plenum.json`: `node apps/gateway/src/bench.ts plenum.json`. It serves simulators only for devices on localhost.
2. Start the gateway in the background: `node --env-file-if-exists=plenum.env apps/gateway/src/main.ts plenum.json`.
3. After about 15 s, read `curl -s http://127.0.0.1:8080/api/status`. Every device should be `"status":"ok"`, and its points should have values. Its gateway log lines say the same.
4. Diagnose what isn't working, fix the config, and restart. Repeat until every device is ok or the cause is outside your reach:

   | Symptom                       | Likely cause                                                                                                                    |
   | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
   | Timeout or connection refused | IP, port, a firewall, or the device only allows one Modbus client: is the BMS already connected?                                |
   | Modbus exception 2            | Address off by one or in the wrong table                                                                                        |
   | Absurd values                 | Scaling, signed vs unsigned, or a device that sends 32-bit values low word first (unsupported: say so and leave that point out) |
   | BACnet `unknown-object`       | Instance changed since discovery: discover again                                                                                |
   | Broker not connected          | URL, TLS (`mqtts://`), credentials in `plenum.env`                                                                              |

5. Show the user a few real values with units, and the status page URL.
6. Stop the background processes before step 8.

## 8. Run it for real

Do whichever the user chose in step 3:

- **systemd** (Pi or Linux): get a yes from the user, then run `sudo packaging/install.sh plenum.json`. It validates the config, installs to `/opt/plenum`, moves the buffer to `/var/lib/plenum`, and starts `plenum-gateway`.
  - Copy secrets: `sudo install -m 640 -g plenum plenum.env /etc/plenum/gateway.env`, then `sudo systemctl restart plenum-gateway`.
  - Check it with `systemctl status plenum-gateway` and `journalctl -u plenum-gateway -n 20`.
- **Docker:**
  - copy `plenum.json` to `/etc/plenum/gateway.json`, with `buffer.path` set to `/var/lib/plenum/buffer.sqlite`;
  - copy `plenum.env` to `/etc/plenum/gateway.env`;
  - give the `docker run` command from the README ("Running it for real"); the image includes the status page.
- **This machine, for now:** give the one command to start it again: `node --env-file-if-exists=plenum.env apps/gateway/src/main.ts plenum.json`.

The status page binds to 127.0.0.1. From a laptop, use `ssh -L 8080:127.0.0.1:8080 <user>@<pi>`. Only on a trusted network, set `status.bindAddress` to `"0.0.0.0"`.

## 9. Wrap up

Five lines at most:

- what's running and where;
- the config path;
- the status page URL;
- where the logs are;
- one next step, picked from:
  - add the remaining registers;
  - send telemetry to Grafana with the `OTEL_*` variables in the env file (`observability/README.md`);
  - make a point writable, with limits (README, "Commands").
