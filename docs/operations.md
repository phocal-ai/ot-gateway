# Running a gateway

How to install, change, upgrade, back up and watch an OT Gateway on a Raspberry Pi or any Linux host. The README covers what the gateway does; [configuration.md](configuration.md) covers every config key; [troubleshooting.md](troubleshooting.md) covers what goes wrong.

The fastest way to a first config is `/setup` in Claude Code (README, "Set it up with AI"). This page is what to do with the result.

## Install

### Docker Compose (recommended)

One image runs on any Linux edge box with Docker, a Raspberry Pi 4 or 5 as much as an industrial PC: `ghcr.io/phocal-ai/ot-gateway`, amd64 and arm64, published for every release. On a Pi it needs the 64-bit Raspberry Pi OS; there is no 32-bit ARM image. It needs Docker Compose 2.24 or newer (`docker compose version`), and no `sudo` or folders made by hand: put [`compose.yaml`](../packaging/compose.yaml) in a folder of its own with `ot-gateway.json` next to it, and start it from there.

```bash
mkdir -p ~/ot-gateway && cd ~/ot-gateway
```

`ot-gateway init .` in that folder asks a few questions and writes all of it: `ot-gateway.json`, `compose.yaml`, and `ot-gateway.env` (yours alone) with an empty line for the broker password when the broker needs a login and the telemetry variables commented out. It never replaces a `compose.yaml` or `ot-gateway.env` that is already there. With Node.js on the machine, `ot-gateway` is `npx ot-gateway` ([The CLI from npm](#the-cli-from-npm)). Without it (a Raspberry Pi has none), the image is the CLI, with the same commands:

```bash
mkdir -p ~/.local/bin && curl -fsSL --retry 4 --retry-all-errors --retry-delay 2 https://raw.githubusercontent.com/phocal-ai/ot-gateway/main/packaging/ot-gateway -o ~/.local/bin/ot-gateway && chmod +x ~/.local/bin/ot-gateway && . ~/.profile
ot-gateway init .
```

The first line installs the command, without `sudo` ([`packaging/ot-gateway`](../packaging/ot-gateway), a short shell script). `--retry-all-errors` makes curl retry a failed name lookup too, which `--retry` alone does not: a router's DNS that drops out for a few seconds would otherwise fail the install. It runs the CLI from the image with the current folder mounted, on the host network so that `discover`, `watch` and `status` reach the building network and the gateway's status page, and as you, so the files it writes are yours. It takes the image tag of the running gateway, or else the one the folder's `compose.yaml` pins (or `~/ot-gateway/compose.yaml`), so the command is always the same version as the gateway, and `OT_GATEWAY_TAG=<tag> ot-gateway …` runs another. A terminal gets colors and prompts; a pipe, a script or an AI agent gets plain lines. Over `ssh pi@host 'command'` the login profile is not read, so call it as `~/.local/bin/ot-gateway`. Give `watch` a `--seconds` there: stopping the `docker` command does not stop the container. `demo`, `run` and `watch` run in containers named after them (`ot-gateway-demo`, `ot-gateway-run`, `ot-gateway-watch`), so `docker stop ot-gateway-demo` stops one left in the background, and a second one is refused while the first runs. The first run (and the first after an upgrade) pulls the image, about 460 MB, and retries a failed pull twice; a wrong tag or no access to Docker fails at once, and either way the last line names the image and Docker's reason.

Fill in the password, then go on with the check below. With a config written elsewhere, fetch `compose.yaml` yourself:

```bash
curl -fsSLO --retry 4 --retry-all-errors --retry-delay 2 https://raw.githubusercontent.com/phocal-ai/ot-gateway/v0.12.0/packaging/compose.yaml
```

and copy `ot-gateway.json` into the folder, and `ot-gateway.env` too if the config names secrets (the broker password under `mqtt.passwordEnv`, `OTEL_*` variables). Compose reads the env file as you, so keep it yours alone: `chmod 600 ot-gateway.env`. Check the config with the gateway itself, then start it:

```bash
docker compose run --rm gateway --check /etc/ot-gateway/ot-gateway.json
```

```bash
docker compose up -d
```

The outbox and the history live in the `ot-gateway_data` volume, mounted at `/var/lib/ot-gateway`. The image sets `OT_GATEWAY_DATA_DIR` to that folder, so a relative `buffer.path` or `history.path` such as `./ot-gateway-buffer.sqlite` (what `ot-gateway init` writes) lands in it rather than in the config's folder, and so does an absolute one under `/var/lib/ot-gateway`. Either way they outlive the container. Outside the container, relative paths resolve against the config file's folder ([configuration.md](configuration.md)).

Compose is for a Linux machine. Docker Desktop on macOS and Windows runs containers in a VM, so host networking does not put the gateway on the building network, and BACnet broadcasts never reach it. There, run the gateway with `ot-gateway run` (`init` says so when it writes `compose.yaml`), or put it on a Linux box.

`compose.yaml` pins a release tag, uses host networking (BACnet discovery and change of value need the building network's broadcasts, and the status page listens on the host's loopback), restarts the gateway after a crash and at boot, gives it 30 seconds to stop cleanly, caps Docker's own log files (it keeps them forever on the SD card otherwise) and holds the container to 768 MB. It mounts its own folder, writable, at `/etc/ot-gateway` and runs `/etc/ot-gateway/ot-gateway.json`, so the status page's Settings tab can save the config ([Editing in the status page](#editing-in-the-status-page)); without `ot-gateway.json` in the folder the gateway stops at once and says how to get one. Raspberry Pi OS boots with memory limits off, and Compose then warns `Your kernel does not support memory limit capabilities` and runs the gateway without one: add `cgroup_enable=memory` to `/boot/firmware/cmdline.txt`, restart the Pi and recreate the container ([raspberry-pi-install.md](raspberry-pi-install.md), part 5). The systemd unit's 512 MB limit below needs the same.

Without Compose, the same as one command, from the same folder:

```bash
docker run -d --name ot-gateway --network host --restart unless-stopped --log-driver local \
  -v "$PWD:/etc/ot-gateway" -v ot-gateway_data:/var/lib/ot-gateway \
  -w /var/lib/ot-gateway --env-file ot-gateway.env ghcr.io/phocal-ai/ot-gateway:v0.12.0 /etc/ot-gateway/ot-gateway.json
```

Leave out `--env-file ot-gateway.env` when there is no such file.

### The CLI from npm

The `ot-gateway` command, with the whole gateway inside, needs only Node.js 22.18 or newer: no checkout, Docker or git. It is how to try the gateway, set up a config and check on a running one, from the machine on the building network or a laptop plugged in on site.

```bash
npx ot-gateway demo                     # the status page on http://127.0.0.1:8080
npx ot-gateway init my-building         # a few questions → my-building/: ot-gateway.json, compose.yaml, ot-gateway.env
npx ot-gateway check ot-gateway.json
```

The CLI reads `ot-gateway.env` from the folder it runs in, as Docker Compose does, and from the folder of the config a command names, so `run`, `watch` and `discover` find the broker password there; a variable already set in the environment wins. For scripts and AI agents, every answer is a flag and `--yes` takes the defaults for the rest, so nothing is asked. Without a terminal on stdin, `init` behaves as with `--yes` and says so on stderr, so it never waits for an answer; a cancelled `init` exits 1: `npx ot-gateway init site-1 --yes --site site-1 --broker mqtts://broker.example:8883 --username gateway --points points.csv`. `--json` on `init`, `check`, `discover`, `import`, `points schema` and `status` prints the result as JSON on stdout, and a failure as `{"ok": false, "error": …}` with exit code 1; logs go to stderr. `init`'s JSON carries what it prints after the config: `notes` (where the broker password goes, what the history takes on disk, and on macOS and Windows why not Docker Compose) `next`, the commands to run next as `{"command", "description"}`, and the status page apart from them: `url` and `page`, the sentence that says what to do there (with no devices yet: add them there, or upload a points list). The text prints each description on its own line under its command. When the folder is not the working directory, every command in `next` names the config's path, so they run from where `init` ran. Run over SSH, `init` adds the tunnel that opens the status page on the laptop (`ssh -L 8080:127.0.0.1:<port> <user>@<host>`, then `http://localhost:8080`); the Docker wrapper passes `SSH_CONNECTION` and `USER` into the container for it. Without `--json`, a failed command prints one line on stderr, such as `error: no points to list; points.csv was not written.`, and exits with 1 (2 for a usage mistake); only `run` and `demo` report a failed start as a log line, like the rest of their log. `init --dry-run` and `import --dry-run` write nothing: they show the config and files, or the devices, that would be written. `npx` runs the latest release; `npm install -g ot-gateway` keeps it installed. To run a gateway unattended, use Docker Compose or systemd.

### systemd, without Docker

Needs Node.js 22.18 or later (24 LTS recommended) and systemd. From a checkout:

```bash
pnpm --filter @ot-gateway/web build
```

```bash
sudo packaging/install.sh ot-gateway.json
```

The script:

- refuses a checkout that is not owned by you (the user running `sudo`) or root, or that group or others can write to, and says which path to `chown` or `chmod`; `git describe`, for the version, runs as the checkout's owner;
- refuses a checkout with symlinks among the files it copies or installs;
- builds the runtime files (and the built status page, if there is one) with their production dependencies in `/opt/ot-gateway.new`;
- creates the system user `ot-gateway`;
- checks the config against the new build as that user, and only then swaps the build in for `/opt/ot-gateway` and the config in as `/etc/ot-gateway/gateway.json`, with the outbox at `/var/lib/ot-gateway/buffer.sqlite`;
- creates `/etc/ot-gateway/gateway.env` (mode 640, group `ot-gateway`) for secrets and `OTEL_*` variables;
- installs and starts `ot-gateway.service`.

The service runs as `ot-gateway` with a read-only view of the system except `/var/lib/ot-gateway`, restarts five seconds after any exit, and is held to 512 MB.

Put the broker password in the env file, under the name the config's `mqtt.passwordEnv` gives:

```bash
sudoedit /etc/ot-gateway/gateway.env
```

```bash
sudo systemctl restart ot-gateway
```

## Change the config

Edit, check, restart. A config that fails the check leaves the running gateway alone. Under systemd:

```bash
sudoedit /etc/ot-gateway/gateway.json
```

```bash
cd /opt/ot-gateway && sudo -u ot-gateway node apps/gateway/src/main.ts --check /etc/ot-gateway/gateway.json
```

```bash
sudo systemctl restart ot-gateway
```

With Docker Compose, edit `ot-gateway.json` next to `compose.yaml`, check it and recreate the container, from that folder:

```bash
docker compose run --rm gateway --check /etc/ot-gateway/ot-gateway.json
```

```bash
docker compose up -d --force-recreate
```

Under systemd, you can also run `install.sh` again with the new file: it checks it before replacing the old one. To find BACnet devices for the config, stop the gateway first (both need UDP 47808), then run `node apps/gateway/src/main.ts --discover /etc/ot-gateway/gateway.json`.

A change by hand is read when the gateway starts: the gateway does not watch the file. The status page's editor is the way to change settings without a restart.

## Editing in the status page

The Settings tab's Gateway, Broker and BACnet/IP cards have an Edit button: site, building, gateway id, health interval, broker URL, user name, client id and MQTT version; the gateway's BACnet/IP port, broadcast address, BBMD, the address it listens on, reply timeout, retries and how long change subscriptions last (`/settings/?bacnet=1`; the card shows while there is no BACnet device yet too, since finding devices uses it). Its Devices card adds a Modbus TCP or BACnet/IP device with its points, finds BACnet devices on the network, edits or removes one, and adds the devices of a points list or an EDE file ([Devices in the status page](#devices-in-the-status-page)). The gateway checks every form as you type (the same check as `ot-gateway check`, each problem under its field), and Save writes the config file and applies it without a restart. The other blocks (`buffer`, `history`, `status`) and simulated devices are still changed in the file, for now.

- **The file stays the source of truth.** The page reads the file as it is on disk, and a save replaces it whole: the new text goes to `ot-gateway.json.tmp`, is flushed to disk and renamed over the file, so a power cut leaves the old file or the new one, never half of one. The previous version is kept as `ot-gateway.json.bak`, with the file's permissions; to go back, copy it over the file and restart the gateway. A save is refused when the file changed since the page read it (an edit by hand, another browser): nothing is written, and the page offers to load the file again.
- **Applied in the running process.** The devices, the broker connection and the outbox stop cleanly (what waits in the outbox stays in its file) and start again with the new config; the status page, its events and the history stay up. When the broker settings changed, the new config counts as applied only once the broker accepts it (10 s at most). When the BACnet/IP settings changed, or the first BACnet device is added, the BACnet/IP socket is opened again on the new port at once, and the config counts as applied only once it is open (5 s at most): a port another program holds rolls the save back with the reason. A config that does not start (the outbox's file cannot be opened, the broker refuses the connection, the BACnet/IP port is taken) is rolled back: the previous config runs again, the file gets its previous text back, and the page shows why. Either way there is an event (`config-applied` or `config-apply-failed`, in `ot-gateway events` and on the Status tab), a log line and the `ot_gateway_config_applies_total` metric by outcome. The status page's own address (`status`) and the history (`history`) are saved but take effect at the next restart, and the page says so.
- **What a new site or building leaves behind.** Values go to the new topics at once, and the old health topic gets the gateway's clean `offline`. The retained `$meta` and health messages under the old site stay on the broker until something clears them (`ot-gateway publish <topic> --retain`). Telemetry's `site` and `building` attributes follow the new config, but the OpenTelemetry resource keeps the values it started with until a restart.
- **Secrets stay in `ot-gateway.env`.** The page never sees or sends the broker password: it shows only whether the variable `mqtt.passwordEnv` names is set.
- **Who may save.** Every request that changes something must come from the page itself: an `Origin` header that matches the address the request went to (a page on another site cannot fake it) and the `X-OT-Gateway: 1` header (which a cross-site page cannot send without a CORS preflight, never granted). With the status page on loopback (`127.0.0.1`, the default), reached on the machine or through an SSH tunnel, that is enough. Bound to the LAN (`status.bindAddress: "0.0.0.0"`), editing is off unless `OT_GATEWAY_EDIT_TOKEN` is set in `ot-gateway.env` (a long random secret: `openssl rand -hex 32`); the page then asks for it once and sends it as `Authorization: Bearer <token>`, keeping it in the browser tab until it closes. The token protects writes only; anyone who can reach the page can still read it.
- **Where it can save.** The gateway's user must be able to write the file and its folder (for the `.tmp` and the `.bak`). With Docker Compose that is the folder mount in `compose.yaml` (below); the container's user is 1000, the first user of a Pi, so a folder owned by another user keeps the page read-only. Under systemd, `/etc/ot-gateway` belongs to root and the page stays read-only: edit the file as above. When the page cannot save, the Settings tab says why and what to change instead of showing Edit, and so does `GET /api/config/edit`.

### Devices in the status page

- **The first run.** While the config has no devices, the Status tab shows a guide in three steps: the broker (connected, or "Test the connection" and a link to its form, `/settings/?broker=1`), the devices (Add Modbus device, Find BACnet devices, Upload a points list or EDE file) and the first values, which show as they arrive and name a device that fails. After the first save it stays above the overview until you close it. Below it, "Other ways" names the AI agent and the command line.
- **Add a device.** "Add Modbus device" asks for an id, host, port and unit id; "Add BACnet device" for the device instance and, when it is not in the gateway's subnet, its address (`ip` or `ip:port`). Each point takes a name (its id follows the name until you change it), where it is read (a Modbus table, address and data type, or a BACnet object type and instance) and a unit (`kW`, `°C`, or a QUDT name such as `unit:KiloW`; the common symbols are written to the file as their QUDT names). Scaling, word order and how values are sent (every read, on change with a deadband, sampled or averaged) are under each point's "Scaling, word order and sending". A bit (a coil, a discrete input, a binary or multi-state object) can be marked as an alarm when on or when off; the Status tab then names it in red while it is. A device or point the form did not change is written back exactly as the file has it, settings the form does not show included. Links open the form: `/settings/?add=modbus-tcp`, `/settings/?add=bacnet-ip`, `/settings/?edit=<device id>`; a device's side panel on the Status tab links to its form.
- **Find BACnet devices.** "Find BACnet devices" (`/settings/?find=1`) asks every device in the gateway's subnet who it is (Who-Is, 3 s), or one address (`ip` or `ip:port`) for a device on another subnet or port, and lists what answers: instance, address, name, and a device instance the config already has. Pick reads the device's object list (the first 300 objects, with names, units and present values): inputs and values are ticked, the ones already configured are not. "Continue with N points" opens the device form with them filled in, ids from their names, to test and save. A device behind a BACnet router answers without an address of its own: add it with "Add BACnet device". Finding uses a UDP socket of its own (the BACnet/IP card's port, 47808 by default, when the gateway reads no BACnet device, a free port otherwise) and the card's broadcast address; when no device answers, the panel links to the card, within 13 s for devices and 25 s for objects, and only one search or test runs at a time.
- **Commands.** A point is read-only until "Allow commands…" in its form: Modbus holding registers and coils, BACnet outputs and values. A numeric point takes the lowest and highest value a command may set first, and the confirmation names the point, where it is on the device and its `…/$set` topic. Save writes `writable: true` with the `limits`; every command then goes through the command guard and is logged, as for a point written in the file. The `config-applied` event and a warning in the log name each point that takes commands now (with its limits), whose limits changed and which no longer takes any. The page itself never writes a value. "Make it read-only" takes `writable` and `limits` out again.
- **Test before saving.** "Test the device" reads every point once (up to 25) with the settings as typed, and Test on a point reads that point: the value as it would be published, scaled and with its unit, or why not and what to check (the same hints as the device panel). A test only reads, over a connection of its own, within 12 s; the broker card's "Test the connection" connects with a client id of its own and sends one message to itself, within 22 s. One test runs at a time, and the same device or broker is not asked again within a second. Many Modbus devices take one or two clients: when a device refuses the test's connection while the gateway holds one to it, the result says so (the gateway's connection is not touched). A BACnet device without an address is found by broadcast, which the test can only hear when the gateway does not hold UDP 47808 itself; the result says when to give the address instead.
- **Upload a points list.** "Upload a points list" takes the CSV that `ot-gateway points template` writes (`ot-gateway points schema` describes its columns) or a BACnet EDE file, by picking or dropping it. The gateway checks it as `ot-gateway import --dry-run` does and lists it device by device: what each adds (protocol, address, points, the lines of the file) or what keeps it out, naming the line. For an EDE file the lines are those of the points list it was translated into, and what is not a point (schedules, trend logs) is named as skipped. Add adds the devices without a mistake, after the ones already in the config, and applies them; a device whose id is already in the config is left out. At most 2 MiB.
- **Remove a device** with "Remove device" in its form, after a confirmation. The previous file is the `.bak`, as for every save.
- Every save restarts the gateway's devices, as any applied config does: each device is read again within its first poll.

The API behind the tests and the upload, for scripts, with the same headers as a save: `POST /api/test/read` with `{"text", "device": <index>, "points"?: [<index>]}` (`{"device", "protocol", "target", "ok", "error"?, "note"?, "points": [{"id", "name", "value"?, "raw"?, "unit"?, "error"?}], "durationMs"}`; `text` is the whole candidate config, `device` its index in `devices`), `POST /api/test/broker` with `{"text"}` (`{"ok", "broker", "protocolVersion"?, "roundTripMs"?, "warnings", "error"?}`), `POST /api/import/check` with `{"text", "name"?}` (`{"format", "notes", "error"?, "devices": [{"name", "id", "protocol"?, "address"?, "lines", "points", "error"?}], "adds": {"devices", "points"}}`) and `POST /api/import/apply` with `{"text", "name"?, "etag"}` (`{"etag", "applied", "devices", "points", "skipped"}`). Finding devices: `POST /api/discover/devices` with `{"address"?, "seconds"?}` (`{"asked", "devices": [{"instance", "address"?, "name"?, "conflicts", "configured"?}], "more", "note"?, "durationMs"}`; at most 200 devices, `seconds` 1 to 10) and `POST /api/discover/objects` with `{"instance", "address"}` (`{"instance", "address", "name", "id", "listed", "objects": [{"objectType", "instance", "name", "id", "unit"?, "value"?, "configured"}], "durationMs"}`; 502 when the device does not answer). A test that cannot run with the candidate is 400 with its issues, a second test or search at once 429.

```bash
curl -s -X POST http://127.0.0.1:8080/api/test/read -H 'Origin: http://127.0.0.1:8080' -H 'X-OT-Gateway: 1' \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile text ot-gateway.json '{text: $text, device: 0}')"
```

### Saving from a script

The API behind the editor: `GET /api/config/edit` (whether this page may save, and why not), `GET /api/config/file` (the text and its `etag`), `POST /api/config/check` with `{"text"}` (`{"valid", "issues": [{"path", "message"}]}`) and `PUT /api/config/file` with `{"text", "etag"}` (`{"etag", "applied": {"summary", "changes", "restartNeeded"}}`; 409 when the file changed, 400 when the config is invalid, 422 when it did not start and was rolled back, 403 when the request may not save). The writes need the headers above:

```bash
curl -s http://127.0.0.1:8080/api/config/file > file.json   # edit the text, keep the etag
curl -s -X PUT http://127.0.0.1:8080/api/config/file -H 'Origin: http://127.0.0.1:8080' -H 'X-OT-Gateway: 1' \
  -H 'Content-Type: application/json' --data @file.json
```

## Upgrade

Pull the release, rebuild the status page, run the installer again. It builds the new version in `/opt/ot-gateway.new`, checks the config against it, and only then swaps it in for `/opt/ot-gateway` and restarts the service; `/etc/ot-gateway` and the outbox stay. The gateway is down for the few seconds of the restart (it stops cleanly on SIGINT), and nothing waiting in the outbox is lost.

```bash
git fetch --tags && git checkout v0.12.0
```

```bash
pnpm install && pnpm --filter @ot-gateway/web build
```

```bash
sudo packaging/install.sh
```

Read the release notes for config changes first. If the new version refuses the config, the installer says so and changes nothing: the old version keeps running with its files and config. Fix the config and run it again.

With Docker Compose, write the new tag into `compose.yaml` and recreate the container, from the folder with `compose.yaml`; going back is the same with the old one. The file keeps the tag, so a later `docker compose up -d` after a config change stays on it. The config, the outbox and the history stay, and the container stops cleanly first:

```bash
sed -i 's/OT_GATEWAY_TAG:-[^}]*/OT_GATEWAY_TAG:-v0.12.0/' compose.yaml && docker compose up -d
```

### From a `compose.yaml` that mounts the config file (v0.12.0 and earlier)

Until v0.12.0, `compose.yaml` mounted `ot-gateway.json` alone, read-only, at `/etc/ot-gateway/gateway.json`. Such a gateway runs on with a newer image as before, and its Settings tab says the file is read-only. To edit in the status page, mount the folder instead: in `compose.yaml`, replace the `ot-gateway.json` volume (the `type: bind` entry with `source: ./ot-gateway.json`) with the folder, and name the config's new path:

```yaml
command: [/etc/ot-gateway/ot-gateway.json]
volumes:
  - .:/etc/ot-gateway
  - data:/var/lib/ot-gateway
```

or fetch the release's `compose.yaml` again (it has both, and keeps the tag it names). The folder must be writable by user 1000 (`ls -ln` shows the owner; the first user of a Pi is 1000). Then recreate the container, from the folder:

```bash
docker compose up -d
```

The outbox and the history stay in the `ot-gateway_data` volume. `ot-gateway.env` is in the mounted folder now too; Compose still passes it as before, and the gateway reads it only for a variable that is not set already.

### From the `/etc/ot-gateway` layout (v0.7.0 and earlier)

Until v0.7.0, `compose.yaml` read the config from `/etc/ot-gateway` and kept the outbox in `/var/lib/ot-gateway`, which had to be made with `sudo` first. Now both live with `compose.yaml`: the config next to it, the outbox and the history in the `ot-gateway_data` volume. To move an existing gateway without losing what is waiting in the outbox, make the folder and copy the config and the secrets into it:

```bash
mkdir -p ~/ot-gateway && cd ~/ot-gateway && cp /etc/ot-gateway/gateway.json ot-gateway.json
```

```bash
[ -e /etc/ot-gateway/gateway.env ] && sudo install -m 600 -o "$USER" /etc/ot-gateway/gateway.env ot-gateway.env
```

Stop the old container cleanly, fetch the new `compose.yaml`, create the new container without starting it, and copy the outbox and the history into its volume:

```bash
docker stop -t 30 ot-gateway && docker rm ot-gateway
```

```bash
curl -fsSLO --retry 4 --retry-all-errors --retry-delay 2 https://raw.githubusercontent.com/phocal-ai/ot-gateway/v0.12.0/packaging/compose.yaml && docker compose create
```

```bash
docker run --rm --user 0 --entrypoint sh -v /var/lib/ot-gateway:/from:ro -v ot-gateway_data:/to ghcr.io/phocal-ai/ot-gateway:v0.12.0 -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'
```

```bash
docker compose start
```

Paths in the config stay as they were: `/var/lib/ot-gateway/buffer.sqlite` is where the volume is mounted. Once the status page shows every device `ok`, `/etc/ot-gateway` and `/var/lib/ot-gateway` can go.

## Moving from Plenum

Until v0.5.0 the project was called Plenum. From v0.6.0 everything that carried the name is called `ot-gateway`, and nothing reads the old names any more. MQTT topics and payloads, the config's keys and the status API are the same. What changes:

| Before (v0.5.0 and earlier)                                              | From v0.6.0                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| image `ghcr.io/phocal-ai/plenum-gateway`                                 | `ghcr.io/phocal-ai/ot-gateway`                                  |
| container `plenum`, `PLENUM_TAG`                                         | container `ot-gateway`, `OT_GATEWAY_TAG`                        |
| `/etc/plenum`, `/var/lib/plenum`, `/opt/plenum`                          | `/etc/ot-gateway`, `/var/lib/ot-gateway`, `/opt/ot-gateway`     |
| service `plenum-gateway`, user `plenum`                                  | service `ot-gateway`, user `ot-gateway`                         |
| `plenum.json`, `plenum.env` in a checkout                                | `ot-gateway.json`, `ot-gateway.env`                             |
| metrics `plenum_*`, attributes `plenum.*`                                | `ot_gateway_*`, `ot_gateway.*`                                  |
| `service.name=plenum-gateway`                                            | `service.name=ot-gateway`                                       |
| dashboard `phocal-plenum-gateway`                                        | `phocal-ot-gateway` (import it; the old one stops getting data) |
| default MQTT client id `plenum-<hostname>`                               | `ot-gateway-<hostname>`                                         |
| `~/.config/phocal/plenum-gateway.env`, `PLENUM_ENV_FILE` (in a checkout) | `~/.config/phocal/ot-gateway.env`, `OT_GATEWAY_ENV_FILE`        |

Variables that the config names, like `mqtt.passwordEnv`, keep working under the names it gives. Only a `service.namespace=plenum` in `OTEL_RESOURCE_ATTRIBUTES` needs changing to `ot-gateway`, so that the new dashboard finds the gateway. A broker that allows clients by id (a Mosquitto ACL with `%c`, EMQX client-id authentication, an AWS IoT policy) refuses the new default id: set `mqtt.clientId` to the old one, `plenum-<hostname>`, or allow the new one first.

### With Docker Compose

Stop the old container cleanly (it says `offline` to the broker and closes the outbox), move the config and the outbox, point the outbox at its new path, and check the config against the new image before starting it:

```bash
docker stop -t 30 plenum && docker rm plenum
```

```bash
sudo mv /etc/plenum /etc/ot-gateway && sudo mv /var/lib/plenum /var/lib/ot-gateway
```

```bash
sudo sed -i 's#/var/lib/plenum/#/var/lib/ot-gateway/#; s#service.namespace=plenum#service.namespace=ot-gateway#' /etc/ot-gateway/gateway.json /etc/ot-gateway/gateway.env
```

```bash
docker run --rm -v /etc/ot-gateway:/etc/ot-gateway:ro ghcr.io/phocal-ai/ot-gateway:v0.12.0 --check /etc/ot-gateway/gateway.json
```

Then go on with [From the `/etc/ot-gateway` layout](#from-the-etcot-gateway-layout-v070-and-earlier), from its first step: it fetches the new `compose.yaml` and moves the config and the outbox next to it. Fetching `compose.yaml` replaces one in the same folder: carry over any change you made to it, and rename `PLENUM_TAG` to `OT_GATEWAY_TAG` in a `.env` next to it. The outbox's rows survive the move: what was waiting is delivered once the new container has the broker. `docker image rm ghcr.io/phocal-ai/plenum-gateway:v0.5.0` frees the old image.

### With systemd

Stop and remove the old service (a drop-in in `plenum-gateway.service.d/` with your overrides moves to `ot-gateway.service.d/`), move the config and the outbox, then install from a v0.12.0 checkout. The installer creates the new user, rewrites the outbox's path and gives the env file to the new group:

```bash
sudo systemctl disable --now plenum-gateway && sudo rm /etc/systemd/system/plenum-gateway.service && sudo systemctl daemon-reload
```

```bash
sudo mv /etc/plenum /etc/ot-gateway && sudo mv /var/lib/plenum /var/lib/ot-gateway
```

```bash
sudo sed -i 's#service.namespace=plenum#service.namespace=ot-gateway#' /etc/ot-gateway/gateway.env
```

```bash
git fetch --tags && git checkout v0.12.0
```

```bash
pnpm install && pnpm --filter @ot-gateway/web build
```

```bash
sudo packaging/install.sh /etc/ot-gateway/gateway.json
```

`pnpm install` comes first because the old `node_modules` still links the old package names, and the status page is built again so the installer does not copy the old one. systemd hands `/var/lib/ot-gateway` to the new user when the service starts (`StateDirectory`). Once it runs, remove what is left: `sudo rm -r /opt/plenum && sudo userdel plenum`.

## The outbox

`buffer.path` holds values read while the broker was unreachable, in order, until they are delivered. It is not a history: delivered rows are deleted, and the file shrinks again after a long outage.

- **Backup** is not needed for normal operation: an empty or missing file is fine, and the gateway recreates it.
- **Disk full:** the gateway keeps publishing directly while the broker takes values, and buffers again once space is back.
- **A corrupt file** is moved aside (`buffer.sqlite.corrupt-<time>`) and a new one started. Its rows were values the broker never got; delete it once you no longer need them.
- **Deleted while running:** the gateway restores it from its open connection, rows included.
- **Rows waiting** is on the status page and in `ot_gateway_buffer_rows`.

## The history

`history.path` holds every read of the last day and per-minute rollups for `retentionDays` (7), for the status page's charts. Unlike the outbox it is a history: nothing in it is waiting to be sent, so losing it loses only the charts.

- **Writes** come every 30 s, sooner on a busy gateway, to spare the SD card. A chart can be up to 30 s behind, and a crash or power cut loses at most the last 30 s of the charts. The current values on the status page do not wait for this.
- **Size** stays bounded by retention: about 170 MB for a day of 200 points read every 5 s, plus 140 MB per week of rollups ([configuration.md](configuration.md#history)). Old rows are deleted every hour and the file returns the space.
- **Disk full:** up to 20,000 reads wait in memory; beyond that the oldest are dropped and counted in `ot_gateway_history_dropped`. Reading and publishing go on regardless.
- **A corrupt file** is moved aside (`history.sqlite.corrupt-<time>`) and a new one started, whether it is found at start or goes corrupt while the gateway runs; delete the old one. Reads waiting in memory go to the new file. While running this happens at most once an hour, so a failing card does not fill up with copies; until then the reads wait in memory as on a full disk. If no new file can be started, the history stays off until the gateway restarts, and `ot_gateway_history_disabled` is 1.
- **Cannot be opened at all** (a read-only directory, say): the gateway runs without history, logs why once and sets `ot_gateway_history_disabled` to 1.

To move a gateway to new hardware with values still waiting, stop the service and copy the file (and any `-wal` file next to it) to the same path on the new one.

## Logs

```bash
journalctl -u ot-gateway -f
```

The gateway logs transitions, not states: a device that stops answering logs once when it starts failing and once when it recovers, with the reason; a broker outage the same. A quiet log is a healthy gateway. Warnings and errors name the device or point.

With Docker: `docker logs -f ot-gateway`.

The first line names the build (`version` on the status page and in telemetry): the release tag in an image, `git describe` for `install.sh`, `dev` from a checkout.

## Status page

With `status` in the config, `http://127.0.0.1:8080` on the gateway shows the alarms that are on, the broker, the devices, the outbox and the machine (below), and every device with its health and its first few values; the Points tab has every value, and the Messages tab what the gateway publishes, command results among them. It listens on loopback by default, so from a laptop:

```bash
ssh -L 8080:127.0.0.1:8080 pi@gateway
```

and open `http://127.0.0.1:8080`. `GET /api/status` serves the same as JSON. The Buffer card says how many messages wait and, from the last minute of polls, when the buffer will be full while the broker is away or how long the backlog takes once it is back. The Status tab's Broker, Devices, Buffer and Machine cards open their details: when the broker connection came up and what the broker allowed (MQTT version, keep-alive, retained messages, largest message), reconnects, failed attempts, values published and publishes that failed; devices by state and protocol with the ones that need a look; and what the buffer stored, sent on and dropped, by reason; the machine's last sample (processor, memory, heap, event-loop lag, disk, temperature and power where the machine has them). A point is an alarm when its Brick class has `Alarm` in it or its Haystack tags include `alarm`: one that is on (true, or a number other than 0) is shown in red and named above the cards. A value is dimmed when it is stale: the device fails or is late, or a polled point was not read for three poll intervals (at least 15 s). A point read by change of value is not stale while its device answers, as the device sends it only when it changes: it shows "COV" and when it last changed. A device row opens the device in a side panel (`/?device=<id>`): its address from the running config, since when it fails (local clock time), the driver's error and what to check for that failure class, its first points with their values, and its events. The Recent events card lists the last ten events from `GET /api/events` in plain words (an alarm by its point's name: "Alarm raised: Main breaker tripped on energy-meter"), with a line above two or more devices that stopped answering within 10 s of each other, as `ot-gateway events` prints it (likely a shared cause: power, a switch, the gateway's own network), asked for with the status poll (`?after=` the newest it has), and Show all lists every event the gateway keeps. A gateway without devices shows the setup guide ([Devices in the status page](#devices-in-the-status-page)). The Settings tab (`/settings`) shows the running config from `GET /api/config`: every block with its defaults filled in and each device without its points (no secrets: the broker password is only named by `passwordEnv`, and shown as set or not set). Its Gateway, Broker and BACnet/IP cards edit those settings, and its Devices card adds, tests, edits and removes devices and uploads points lists, applied without a restart ([Editing in the status page](#editing-in-the-status-page)). The Messages tab (`/messages`) shows the latest message the gateway published on each topic (`GET /api/messages`, at most 2,000 topics and 2,000 characters of each payload), fetched only while the tab is open, with a search over topics and payloads and a filter by kind. The Points page (`/points`) lists every configured point from `GET /api/points` (topic, source, publish mode, `cov` when it is read by change of value, scaling, limits, Brick and Haystack), fetched once. It draws only the rows on screen and polls only their values with `GET /api/values?points=device/point,...` (at most 500 per request), while the page's status poll uses `GET /api/status?points=none`: at 10,000 points, the full `/api/status` is about 1.3 MB, without points about 27 KB.

## What changed and when

`ot-gateway status`, `events`, `history` and `messages` ask the running gateway of a config: the one named (`ot-gateway status site-1/ot-gateway.json`), else `ot-gateway.json` in this folder, at the address its `status` block gives (`bindAddress`, asked on `127.0.0.1` when it is `0.0.0.0`, and `port`). `--url` asks elsewhere; with neither a config nor `--url` they ask `http://127.0.0.1:8080`. Each names the gateway that answered first, and when the config was given and another gateway answers there (a second gateway on the machine, an old SSH tunnel), it says `WRONG GATEWAY` with both names and exits with 1 instead of reporting on the wrong building.

`ot-gateway status` prints one line for the gateway, its broker and buffer, and one per device. A failing device says since when and why, and below it the first thing to check for that failure (the status page's device panel has the rest); the broker says since when it is connected or away, with the last error and the failed connects since start:

```
s/b gateway main, up 2 h (since 10:19:30)
  broker mqtt://localhost:1883: connected since 10:19:31, 2 failed connect(s) since start
  2 device(s), 1 failing
    ventilation-1  ok       simulator, 0 point(s), read 2 s ago
    energy-meter   failing  modbus-tcp, 4 point(s), failing since 12:18:20 (70 s): could not connect: connection refused by 127.0.0.1:5020
                   check: Is the device switched on and its Modbus TCP server (or its network module) enabled?
```

When every device (two or more) stopped answering within 10 s of the others, a line says so: `all 3 devices stopped answering within 6 s of each other: likely a shared cause (power, a switch, the gateway's own network)`.

A gateway that is fine now still says what happened lately, so an outage that is over is not missed: the alarm points (`alarmWhen` in the config) with the ones that are active or changed in the last 15 minutes, and, from the events, the devices that failed and the broker outages of the last 15 minutes:

```
plant-1/hall-a gateway main, up 6 h (since 08:02:11)
  broker mqtt://broker.lan:1883: connected since 14:21:40, 6 failed connect(s) since start
  buffer: 0 of 100000 message(s) waiting
  3 device(s)
    energy-meter  ok       modbus-tcp, 4 point(s), read 3 s ago
    pv-inverter   ok       modbus-tcp, 3 point(s), read 1 s ago
    ahu-1         ok       bacnet-ip, 6 point(s), read 4 s ago
  3 alarm point(s), 1 active
    ahu-1/filter-alarm            ACTIVE since 14:24:02 (8 min), raised 1 time(s) in the last 15 min
    energy-meter/breaker-tripped  off since 14:22:30, raised 1 time(s) in the last 15 min
  2 device(s) failed in the last 15 min (14:20:03–14:20:06: energy-meter, pv-inverter), see ot-gateway events
  broker connection lost 1 time(s) in the last 15 min, see ot-gateway events
```

An active alarm does not make `status` exit with 1: it is the building's state, not the gateway's.

It exits with 1 while a device is `failing` or `late` (`ok`, but no read for three poll intervals and at least 15 s: a stuck polling cycle, as on the status page), or while the broker is not connected after a connection was lost or a connect failed or was refused. A gateway that has just started is fine: devices `starting`, and the broker line says `connecting (started 2 s ago)` until the first connect succeeds or fails. So a script or an agent can tell from the exit code alone. `--json` prints `/api/status` with `ok: true` or `false` in front, each failing device with `hints`: `{meaning, checks}`, the checks most likely first, and `recent`: `{windowMs, failedDevices, from?, to?, brokerOutages}`. In `/api/status`, a failing device has `failingSince`, `lastError` and `failures` (failed polling cycles in a row); `lastSuccess` is when the reads of the device's last successful polling cycle came back, and it stays while the device fails. A point's `ts` can be newer than `lastSuccess`: a change-of-value notification or a pushed value arrives between cycles. The broker has `disconnectedSince` and `lastError` while it is away, `connects` (successful connects) and `failedConnects` (dials that failed or were refused) since start.

`ot-gateway events` prints what changed, oldest first, in this machine's clock time, after the gateway's name:

```
plant-1/hall-a gateway main at http://127.0.0.1:8080
14:20:01  broker                        disconnected: connection closed by the peer
14:20:03  energy-meter                  failing: no answer within 2000 ms
                                        check: Is the unit id in the config the device's? Many answer only to theirs (often 1, sometimes 255 over TCP).
14:20:06  pv-inverter                   failing: could not connect: host unreachable 10.0.4.21:502
                                        check: Is the device switched on and its network cable plugged in (link light)?
                                        2 devices (energy-meter, pv-inverter) stopped answering within 3 s of each other: likely a shared cause (power, a switch, the gateway's own network)
14:21:40  broker                        connected again after 99 s, 1204 message(s) waiting in the buffer at reconnect
14:22:30  energy-meter/breaker-tripped  alarm raised (value true)
14:22:31  buffer                        drained: 1266 message(s) delivered from the buffer since it was last empty
14:22:40  energy-meter                  ok again after 3 min
14:22:44  pv-inverter                   ok again after 3 min
14:23:30  energy-meter/breaker-tripped  alarm cleared after 60 s (value false)
14:24:02  ahu-1/filter-alarm            alarm raised (value true)
```

Under each failure is the first thing to check for it, by the device's protocol and the failure's reason, as `status` gives it for a device failing now; after several devices that failed within 10 s of each other, a line says they likely share a cause. In `--json` each failure has `hint` (`{meaning, checks}`) and, in such a group, `sharedCause`.

`--since 10m|2h|1d|all` sets how far back (default `1h`), `--json` gives `{ok, gateway, now, capacity, dropped, events}`. `--follow` (`-f`) then prints each new event as it comes, asking every 2 s, until Ctrl-C or for `--seconds N`; with `--json` it prints one event per line (NDJSON). It says on stderr when the gateway stops answering and when it is back, and when the gateway restarted. The events are the gateway started, a device failing (with its reason and error) and ok again (with how long it was down), the broker lost (once per outage, with the error) and connected (with how long it was away and how many messages waited in the buffer at that moment), the buffer drained (with how many messages went from it to the broker since it was last empty: the backlog and the values that queued behind it while it went out, so usually more than were waiting at the reconnect), and an alarm point raised (`first: true` when it was already active at its first read) or cleared (with how long it was active). An alarm that chatters lists at most 6 changes in 15 minutes; then one `alarm-flapping` event says so, its changes are counted instead of listed, and `alarm-settled` comes once it has kept still for 5 minutes, with how many changes were counted. All alarm points together list at most 60 events in 15 minutes, so a building full of chattering contacts cannot push the device failures out of the 500 events kept. Every alarm change is counted in `ot_gateway_alarm_changes` (by `transition`, `raised` or `cleared`), and `ot_gateway_alarms_active` is how many are active. The gateway keeps the latest 500 in memory, so they start over on a restart, and serves them as `GET /api/events` (`?after=<id>` for the ones after an event already seen, every one when the gateway has not given that id yet because it restarted; `?since=<ms epoch>` for those at or after a time). Durations are measured on the monotonic clock, so a clock step does not bend them. For more, read the log: `docker compose logs gateway --since 10m` in the gateway's folder.

`ot-gateway history <device>/<point>` prints what a point did lately, from the gateway's history (`history` in the config; [The history](#the-history)): the last 10 minutes in about 10 buckets unless `--since 30s|10m|2h|1d` and `--buckets N` say otherwise, the range ending at the gateway's own clock. A device alone gives all of its points, and several are comma-separated (`meter/power,meter/energy`). Each bucket is a line in local time with the average and its unit, the minimum, the maximum and the number of reads; a stretch without reads is a line of its own (`the gateway was not running` when the gateway's start ends it), and the newest half minute may be `not written yet`. The heading says whether the buckets come from every read (buckets finer than a minute, or a range of an hour or less, that starts within the last day: so the default 10 minutes end at now) or from the per-minute rollups, where the current minute is marked `so far`:

```
plant-1/hall-a gateway main at http://127.0.0.1:8080: the last 2m, until 13:26:18

pv-inverter/ac-power (PV inverter AC power, kW): 15 s buckets from every read
  13:24:18  no reads for 75 s, until 13:25:33
  13:25:33  avg 0.193 kW  min 0.021  max 0.53  (5 reads)
  13:25:48  avg 2.53 kW  min 0.545  max 4.855  (7 reads)
  13:26:03  avg 6.339 kW  min 5.651  max 6.992  (3 reads)
```

A switch or an alarm (a point whose value is true or false) reads as on or off per bucket instead of an average, followed by when it changed, from every read (within the last day; the text lists the first 20, `--json` up to 200):

```
energy-meter/breaker-tripped (Breaker tripped): 1 min buckets from every read
  14:22:10  on in 8 of 12 reads
  14:23:10  on in 4 of 12 reads
  14:24:10  off, all 12 reads
  ...
  14:31:10  off, all 5 reads
  changes, from every read:
    14:22:10  off at the first read in this range
    14:22:30  switched on
    14:23:30  switched off
```

`--json` gives `{ok, gateway, now, since, series}`, each series as `/api/history` returns it plus the point's `name`, `unit` and `unitLabel`, `boolean: true` for a switch, and its `gaps` (`[{from, to}]`, Unix ms). A gateway without a history, or a point it does not have, is said in words with what to do (the closest point id, or the `history` block to add).

### What the numbers mean

- **`broker.published`** (`/api/status`, gateway-wide): point values the pipeline handed on since start, delivered or not. **`broker.publishFailures`**: publishes that failed (without a buffer, those values are lost).
- **`buffer`**: `written` went into the outbox while the broker was away (or behind older rows), `delivered` came out of it to the broker, `dropped` were given up on, by reason in `droppedBy`; `rows` wait now.
- **`/api/messages` `count`** (per topic): messages the gateway published on that topic since it started, also while the broker was down (into the buffer, or lost without one). **`delivered`**: of those, and of ones the buffer kept from before a restart, how many reached the broker (QoS 1 acknowledged by it, QoS 0 written to its connection), straight or from the buffer. While the broker is up the two move together; after an outage `count - delivered` is roughly what still waits in the buffer or was lost.
- **`broker-connected` `buffered`**: rows waiting at the moment of the reconnect. **`buffer-drained` `delivered`**: messages that went from the buffer to the broker since it was last empty.

### The API's answers

All times are Unix ms on the gateway's wall clock; `now` in an answer is the gateway's clock when it answered.

- `GET /api/status[?points=none]`: `{site, building, id, since, now, broker, buffer?, host?, devices: [{id, protocol, status, pollIntervalMs, reason?, failingSince?, lastError?, failures?, lastSuccess?, pointCount, points: [{id, name, unit?, writable, value?, ts?, alarmWhen?, alarmActive?}]}], alarms?: [{device, point, alarmWhen, active?, since?, raised, flapping}], commands}`; `alarms` lists every alarm point, also with `points=none`, `raised` counting the last 15 minutes.
- `GET /api/points`: `{points: [{device, id, name, unit?, writable, topic, source, read, cov, publish, limits?, scaling?, brick?, haystack?}]}`, every configured point in config order.
- `GET /api/values?points=device/point,...`: `{readings: [{device, point, value?, ts?}]}`.
- `GET /api/messages`: `{messages: [{topic, payload, truncated, retained, at, count, delivered}], droppedTopics}`, sorted by topic.
- `GET /api/events[?after=<id>|since=<ms>]`: `{now, capacity, dropped, events: [{id, at, type, ...}]}`, oldest first; `type` is `gateway-started`, `device-failing`, `device-recovered`, `broker-disconnected`, `broker-connected`, `buffer-drained`, `config-applied`, `config-apply-failed`, `alarm-raised`, `alarm-cleared`, `alarm-flapping` or `alarm-settled`.
- `GET /api/history?device=&point=[&from=&to=&buckets=&changes=true]`: `{device, point, from, to, stepMs, resolution: "read"|"minute", buckets: [{t, min, max, avg, count}], changes?: {list: [{t, value}], truncated}}`, buckets without a read left out; `changes` (asked for, and a range that starts within the last day) is the first read and every read whose value differed from the one before, at most 200; 404 without a history, 400 for a point the config does not have.

`ot-gateway messages [device/point]` prints, per topic, how many messages the gateway published since it started and how many reached the broker (from `/api/messages`; [What the numbers mean](#what-the-numbers-mean)), with the last one's time and payload; `--json` for scripts and agents. It counts since start, not per time window: the history keeps the reads, not what went out.

```
plant-1/hall-a gateway main at http://127.0.0.1:8080: messages per topic since it started at 08:02:11 (6 h ago)
  energy-meter/active-power        4380 sent, 4380 reached the broker,  last 14:32:08  {"value":12.4,"ts":1794403928000}
  energy-meter/active-power/$meta     1 sent, 1 reached the broker,  last 08:02:12 retained  {"name":"Active power","unit":"unit:KiloW",…}
```

`ot-gateway watch` says when it loses the broker and when it is back; with `--seconds` it exits with 1 when the broker was lost and did not come back. A retained message the broker keeps from another gateway, or for a device or point the config does not have (an older config's), is marked, `retained (from gateway old-pi)` or `retained (point not in this config)` (`"stale"` in `--json`), and the first one prints, once, how to clear it: `ot-gateway publish <topic> --retain`. The gateway clears the `$meta` of its own points that are gone by itself; the rest it leaves, as nothing says whose they are now.

## Health on MQTT

The gateway keeps a retained message on `site/building/$gateway/<id>/health`: `online` with every device's status, last successful read and, for a failing device, `failingSince`, refreshed every `healthIntervalMs` and within a second of a device changing status (at most one such refresh a second), and `offline` (its MQTT last will) when it stops or loses the broker. Alert on that topic from whatever reads the broker.

The `online` message also carries `host`, the machine's last sample (below): `memoryBytes`, `eventLoopLagMs`, `clockSteps`, and where the machine can tell, `temperatureC`, `throttled` with `throttledWatched` (the conditions the Pi lets the gateway see, below) and `diskFreeBytes`. So a fleet can be watched from the broker alone, without Grafana.

## The machine

Every 15 seconds the gateway samples itself and the machine under it, natively and in a container alike (it reads `/proc/self`, `/sys` and Node, needs no privileges and runs no commands). The status page's Machine card sums the machine up while it is fine (processor, memory, temperature); when the power supply is too weak, the Pi throttles, it runs at 80 °C or more, the disk has under 64 MB free or the gateway stalls or runs above 90 % CPU (after its first minute, which is busy with starting up), a notice at the top says so and what to do (the raw sample is in `/api/status`); telemetry exports it (`ot_gateway_process_*`, `ot_gateway_event_loop_lag_seconds`, `ot_gateway_host_*`, `ot_gateway_clock_steps_total`, `ot_gateway_buffer_disk_free_bytes`, and per device `ot_gateway_driver_request_seconds_total`); the health message carries the essentials. Each problem is logged when it starts and when it ends:

| Log line                                    | What it means                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event loop stalled`                        | Something blocked the gateway's one thread for a second or more: every device, keepalive and deadline waited. On a Pi, usually a slow SD card under a large outbox write, or swapping.                                                                                           |
| `host reports a power or thermal condition` | The Raspberry Pi firmware reports under-voltage, a capped frequency, throttling or the soft temperature limit. Under-voltage is a weak power supply or cable, and the most common cause of a corrupted SD card: fix it before anything else. Cleared after a minute without one. |
| `host is hot`                               | The SoC reached 80 °C (a Pi 4 throttles from there). Use a case with a heatsink, or a fan.                                                                                                                                                                                       |
| `the outbox's disk is nearly full`          | Less than 64 MiB free where the outbox lives. The gateway keeps publishing directly while the broker takes values, but cannot buffer an outage.                                                                                                                                  |
| `wall clock stepped`                        | NTP set the time: normal once after boot on a machine without a real-time clock. Timestamps jump with it; deadlines and retries do not. Steps without a reboot mean a flaky time source.                                                                                         |

The gateway reads the firmware's flags every second, so a dip between two samples is not missed. What it can read depends on the kernel. The kernel's voltage driver asks the firmware every two seconds and clears what the firmware remembered each time, so neither the gateway nor `vcgencmd get_throttled` sees anything older than two seconds, on any Raspberry Pi kernel. Raspberry Pi kernel 6.12 and later (6.12 builds since March 2025, and so all of Raspberry Pi OS 13) also stopped showing programs the firmware's whole report, and pass on only the under-voltage alarm; 6.6 and older still show it, and the kernel logs a one-time `deprecated, use hwmon sysfs instead` warning with a backtrace when the gateway first reads it, which is harmless. There the gateway reports under-voltage alone (`throttled.watched` in the status and `throttledWatched` in the health message are `["under_voltage"]`; with `--log-level debug` the log also names the source the gateway found), and `ot_gateway_host_throttled` has no series for the other conditions rather than a 0. On every kernel the record since boot is the kernel log: `journalctl -k -g voltage`.

[raspberry-pi-testing.md](raspberry-pi-testing.md) is how to test a gateway on a Pi before it goes into a building.

## Telemetry

With the standard OpenTelemetry variables in `ot-gateway.env` next to `compose.yaml` (or `/etc/ot-gateway/gateway.env` under systemd), the gateway sends traces, metrics and logs over OTLP; without them, nothing. See [observability/README.md](../observability/README.md) for the variables, the dashboard and the Grafana Cloud free-plan budget.

## Uninstall

With Docker Compose, from the folder with `compose.yaml`; `-v` also deletes the volume with the outbox and the history:

```bash
docker compose down -v
```

Under systemd:

```bash
sudo systemctl disable --now ot-gateway
```

```bash
sudo rm -rf /opt/ot-gateway /etc/systemd/system/ot-gateway.service
```

Then remove `/etc/ot-gateway` (config and secrets) and `/var/lib/ot-gateway` (the outbox) if you no longer need them, and the user with `sudo userdel ot-gateway`.
