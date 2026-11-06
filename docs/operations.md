# Running a gateway

How to install, change, upgrade, back up and watch an OT Gateway on a Raspberry Pi or any Linux host. The README covers what the gateway does; [configuration.md](configuration.md) covers every config key; [troubleshooting.md](troubleshooting.md) covers what goes wrong.

The fastest way to a first config is `/setup` in Claude Code (README, "Set it up with AI"). This page is what to do with the result.

## Install

### Docker Compose (recommended)

One image runs on any Linux edge box with Docker, a Raspberry Pi 4 or 5 as much as an industrial PC: `ghcr.io/phocal-ai/ot-gateway`, amd64 and arm64, published for every release. On a Pi it needs the 64-bit Raspberry Pi OS; there is no 32-bit ARM image. It needs Docker Compose 2.24 or newer (`docker compose version`), and no `sudo` or folders made by hand: put [`compose.yaml`](../packaging/compose.yaml) in a folder of its own with `ot-gateway.json` next to it, and start it from there.

```bash
mkdir -p ~/ot-gateway && cd ~/ot-gateway
```

With Node.js on the machine, `npx ot-gateway init` in that folder asks a few questions and writes all of it: `ot-gateway.json`, `compose.yaml`, and `ot-gateway.env` (yours alone) with an empty line for the broker password when the broker needs a login. It never replaces a `compose.yaml` or `ot-gateway.env` that is already there. Fill in the password, then go on with the check below. Without Node, fetch `compose.yaml` yourself:

```bash
curl -fsSLO https://raw.githubusercontent.com/phocal-ai/ot-gateway/v0.7.0/packaging/compose.yaml
```

Copy `ot-gateway.json` into the folder, and `ot-gateway.env` too if the config names secrets (the broker password under `mqtt.passwordEnv`, `OTEL_*` variables). Compose reads the env file as you, so keep it yours alone: `chmod 600 ot-gateway.env`. Check the config with the gateway itself, then start it:

```bash
docker compose run --rm gateway --check /etc/ot-gateway/gateway.json
```

```bash
docker compose up -d
```

The outbox and the history live in the `ot-gateway_data` volume, which is also the gateway's working directory: a relative `buffer.path` such as `./ot-gateway-buffer.sqlite` (what `ot-gateway init` writes) lands in it, and so does an absolute one under `/var/lib/ot-gateway`. Either way they outlive the container.

`compose.yaml` pins a release tag, uses host networking (BACnet discovery and change of value need the building network's broadcasts, and the status page listens on the host's loopback), restarts the gateway after a crash and at boot, gives it 30 seconds to stop cleanly, caps Docker's own log files (it keeps them forever on the SD card otherwise) and holds the container to 768 MB. It refuses to start without `ot-gateway.json` next to it rather than mount an empty folder in its place. Raspberry Pi OS boots with memory limits off, and Compose then warns `Your kernel does not support memory limit capabilities` and runs the gateway without one: add `cgroup_enable=memory` to `/boot/firmware/cmdline.txt`, restart the Pi and recreate the container ([raspberry-pi-install.md](raspberry-pi-install.md), part 5). The systemd unit's 512 MB limit below needs the same.

Without Compose, the same as one command, from the same folder:

```bash
docker run -d --name ot-gateway --network host --restart unless-stopped --log-driver local \
  -v "$PWD/ot-gateway.json:/etc/ot-gateway/gateway.json:ro" -v ot-gateway_data:/var/lib/ot-gateway \
  -w /var/lib/ot-gateway --env-file ot-gateway.env ghcr.io/phocal-ai/ot-gateway:v0.7.0
```

Leave out `--env-file ot-gateway.env` when there is no such file.

### The CLI from npm

The `ot-gateway` command, with the whole gateway inside, needs only Node.js 22.18 or newer: no checkout, Docker or git. It is how to try the gateway, set up a config and check on a running one, from the machine on the building network or a laptop plugged in on site.

```bash
npx ot-gateway demo                     # the status page on http://127.0.0.1:8080
npx ot-gateway init                     # a few questions → ot-gateway.json, compose.yaml, ot-gateway.env
npx ot-gateway check ot-gateway.json
```

The CLI reads `ot-gateway.env` from the folder it runs in, as Docker Compose does, so `run`, `watch` and `discover` find the broker password there; a variable already set in the environment wins. `npx` runs the latest release; `npm install -g ot-gateway` keeps it installed. To run a gateway unattended, use Docker Compose or systemd.

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
docker compose run --rm gateway --check /etc/ot-gateway/gateway.json
```

```bash
docker compose up -d --force-recreate
```

Under systemd, you can also run `install.sh` again with the new file: it checks it before replacing the old one. To find BACnet devices for the config, stop the gateway first (both need UDP 47808), then run `node apps/gateway/src/main.ts --discover /etc/ot-gateway/gateway.json`.

## Upgrade

Pull the release, rebuild the status page, run the installer again. It builds the new version in `/opt/ot-gateway.new`, checks the config against it, and only then swaps it in for `/opt/ot-gateway` and restarts the service; `/etc/ot-gateway` and the outbox stay. The gateway is down for the few seconds of the restart (it stops cleanly on SIGINT), and nothing waiting in the outbox is lost.

```bash
git fetch --tags && git checkout v0.7.0
```

```bash
pnpm install && pnpm --filter @ot-gateway/web build
```

```bash
sudo packaging/install.sh
```

Read the release notes for config changes first. If the new version refuses the config, the installer says so and changes nothing: the old version keeps running with its files and config. Fix the config and run it again.

With Docker Compose, name the new tag, from the folder with `compose.yaml`; going back is the same with the old one. The config, the outbox and the history stay, and the container stops cleanly first:

```bash
OT_GATEWAY_TAG=v0.7.0 docker compose up -d
```

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
curl -fsSLO https://raw.githubusercontent.com/phocal-ai/ot-gateway/v0.7.0/packaging/compose.yaml && docker compose create
```

```bash
docker run --rm --user 0 --entrypoint sh -v /var/lib/ot-gateway:/from:ro -v ot-gateway_data:/to ghcr.io/phocal-ai/ot-gateway:v0.7.0 -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'
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
docker run --rm -v /etc/ot-gateway:/etc/ot-gateway:ro ghcr.io/phocal-ai/ot-gateway:v0.7.0 --check /etc/ot-gateway/gateway.json
```

Then go on with [From the `/etc/ot-gateway` layout](#from-the-etcot-gateway-layout-v070-and-earlier), from its first step: it fetches the new `compose.yaml` and moves the config and the outbox next to it. Fetching `compose.yaml` replaces one in the same folder: carry over any change you made to it, and rename `PLENUM_TAG` to `OT_GATEWAY_TAG` in a `.env` next to it. The outbox's rows survive the move: what was waiting is delivered once the new container has the broker. `docker image rm ghcr.io/phocal-ai/plenum-gateway:v0.5.0` frees the old image.

### With systemd

Stop and remove the old service (a drop-in in `plenum-gateway.service.d/` with your overrides moves to `ot-gateway.service.d/`), move the config and the outbox, then install from a v0.7.0 checkout. The installer creates the new user, rewrites the outbox's path and gives the env file to the new group:

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
git fetch --tags && git checkout v0.7.0
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

- **Size** stays bounded by retention: about 150 MB for a day of 200 points read every 5 s, plus 15 MB per week of rollups. Old rows are deleted every hour and the file returns the space.
- **Disk full:** up to 20,000 reads wait in memory; beyond that the oldest are dropped and counted in `ot_gateway_history_dropped`. Reading and publishing go on regardless.
- **A corrupt file** is moved aside (`history.sqlite.corrupt-<time>`) and a new one started; delete the old one.
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

With `status` in the config, `http://127.0.0.1:8080` on the gateway shows the broker, the outbox, the machine (below), every device with its health and latest values, and recent commands. It listens on loopback by default, so from a laptop:

```bash
ssh -L 8080:127.0.0.1:8080 pi@gateway
```

and open `http://127.0.0.1:8080`. `GET /api/status` serves the same as JSON. The page's Messages section shows the latest message the gateway published on each topic (`GET /api/messages`, at most 2,000 topics and 2,000 characters of each payload); with more than 50 points it starts closed and is fetched only while open.

## Health on MQTT

The gateway keeps a retained message on `site/building/$gateway/<id>/health`: `online` with every device's status and last successful read, refreshed every `healthIntervalMs`, and `offline` (its MQTT last will) when it stops or loses the broker. Alert on that topic from whatever reads the broker.

The `online` message also carries `host`, the machine's last sample (below): `memoryBytes`, `eventLoopLagMs`, `clockSteps`, and where the machine can tell, `temperatureC`, `throttled` with `throttledWatched` (the conditions the Pi lets the gateway see, below) and `diskFreeBytes`. So a fleet can be watched from the broker alone, without Grafana.

## The machine

Every 15 seconds the gateway samples itself and the machine under it, natively and in a container alike (it reads `/proc/self`, `/sys` and Node, needs no privileges and runs no commands). The status page shows the sample; telemetry exports it (`ot_gateway_process_*`, `ot_gateway_event_loop_lag_seconds`, `ot_gateway_host_*`, `ot_gateway_clock_steps_total`, `ot_gateway_buffer_disk_free_bytes`, and per device `ot_gateway_driver_request_seconds_total`); the health message carries the essentials. Each problem is logged when it starts and when it ends:

| Log line                                    | What it means                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event loop stalled`                        | Something blocked the gateway's one thread for a second or more: every device, keepalive and deadline waited. On a Pi, usually a slow SD card under a large outbox write, or swapping.                                                                                           |
| `host reports a power or thermal condition` | The Raspberry Pi firmware reports under-voltage, a capped frequency, throttling or the soft temperature limit. Under-voltage is a weak power supply or cable, and the most common cause of a corrupted SD card: fix it before anything else. Cleared after a minute without one. |
| `host is hot`                               | The SoC reached 80 °C (a Pi 4 throttles from there). Use a case with a heatsink, or a fan.                                                                                                                                                                                       |
| `the outbox's disk is nearly full`          | Less than 64 MiB free where the outbox lives. The gateway keeps publishing directly while the broker takes values, but cannot buffer an outage.                                                                                                                                  |
| `wall clock stepped`                        | NTP set the time: normal once after boot on a machine without a real-time clock. Timestamps jump with it; deadlines and retries do not. Steps without a reboot mean a flaky time source.                                                                                         |

The gateway reads the firmware's flags every second, so a dip between two samples is not missed. What it can read depends on the kernel. The kernel's voltage driver asks the firmware every two seconds and clears what the firmware remembered each time, so neither the gateway nor `vcgencmd get_throttled` sees anything older than two seconds, on any Raspberry Pi kernel. Raspberry Pi kernel 6.12 and later (6.12 builds since March 2025, and so all of Raspberry Pi OS 13) also stopped showing programs the firmware's whole report, and pass on only the under-voltage alarm; 6.6 and older still show it, and the kernel logs a one-time `deprecated, use hwmon sysfs instead` warning with a backtrace when the gateway first reads it, which is harmless. There the gateway reports under-voltage alone (`throttled.watched` in the status and `throttledWatched` in the health message are `["under_voltage"]`, the status page says so, and the log says so in one line when the gateway finds the sensor), and `ot_gateway_host_throttled` has no series for the other conditions rather than a 0. On every kernel the record since boot is the kernel log: `journalctl -k -g voltage`.

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
