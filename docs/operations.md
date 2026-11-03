# Running a gateway

How to install, change, upgrade, back up and watch a Plenum gateway on a Raspberry Pi or any Linux host. The README covers what the gateway does; [configuration.md](configuration.md) covers every config key; [troubleshooting.md](troubleshooting.md) covers what goes wrong.

The fastest way to a first config is `/setup` in Claude Code (README, "Set it up with AI"). This page is what to do with the result.

## Install

### systemd (recommended on a Pi)

Needs Node.js 22.18 or later (24 LTS recommended) and systemd. From a checkout:

```bash
pnpm --filter @plenum/web build
```

```bash
sudo packaging/install.sh plenum.json
```

The script:

- refuses a checkout with symlinks among the files it copies;
- builds the runtime files (and the built status page, if there is one) with their production dependencies in `/opt/plenum.new`;
- creates the system user `plenum`;
- checks the config against the new build as that user, and only then swaps the build in for `/opt/plenum` and the config in as `/etc/plenum/gateway.json`, with the outbox at `/var/lib/plenum/buffer.sqlite`;
- creates `/etc/plenum/gateway.env` (mode 640, group `plenum`) for secrets and `OTEL_*` variables;
- installs and starts `plenum-gateway.service`.

The service runs as `plenum` with a read-only view of the system except `/var/lib/plenum`, restarts five seconds after any exit, and is held to 512 MB.

Put the broker password in the env file, under the name the config's `mqtt.passwordEnv` gives:

```bash
sudoedit /etc/plenum/gateway.env
```

```bash
sudo systemctl restart plenum-gateway
```

### Docker

The image (`ghcr.io/phocal-ai/plenum-gateway`, amd64 and arm64, published for releases) reads `/etc/plenum/gateway.json` and runs as uid 1000. Set `buffer.path` to `/var/lib/plenum/buffer.sqlite` so the outbox outlives the container, and give the directory to uid 1000:

```bash
sudo install -d -o 1000 -g 1000 /var/lib/plenum
```

```bash
sudo install -m 600 -o 1000 -g 1000 plenum.env /etc/plenum/gateway.env
```

```bash
docker run -d --name plenum --network host --restart unless-stopped \
  -v /etc/plenum:/etc/plenum:ro -v /var/lib/plenum:/var/lib/plenum \
  ghcr.io/phocal-ai/plenum-gateway:latest
```

Host networking lets BACnet discovery hear broadcast I-Ams and the status page listen on the host's loopback.

## Change the config

Edit, check, restart. A config that fails the check leaves the running gateway alone.

```bash
sudoedit /etc/plenum/gateway.json
```

```bash
cd /opt/plenum && sudo -u plenum node apps/gateway/src/main.ts --check /etc/plenum/gateway.json
```

```bash
sudo systemctl restart plenum-gateway
```

Or run `install.sh` again with the new file: it checks it before replacing the old one. To find BACnet devices for the config, stop the gateway first (both need UDP 47808), then run `node apps/gateway/src/main.ts --discover /etc/plenum/gateway.json`.

## Upgrade

Pull the release, rebuild the status page, run the installer again. It builds the new version in `/opt/plenum.new`, checks the config against it, and only then swaps it in for `/opt/plenum` and restarts the service; `/etc/plenum` and the outbox stay. The gateway is down for the few seconds of the restart (it stops cleanly on SIGINT), and nothing waiting in the outbox is lost.

```bash
git fetch --tags && git checkout v0.4.0
```

```bash
pnpm install && pnpm --filter @plenum/web build
```

```bash
sudo packaging/install.sh
```

Read the release notes for config changes first. If the new version refuses the config, the installer says so and changes nothing: the old version keeps running with its files and config. Fix the config and run it again.

With Docker, pull the new tag and recreate the container.

## The outbox

`buffer.path` holds values read while the broker was unreachable, in order, until they are delivered. It is not a history: delivered rows are deleted, and the file shrinks again after a long outage.

- **Backup** is not needed for normal operation: an empty or missing file is fine, and the gateway recreates it.
- **Disk full:** the gateway keeps publishing directly while the broker takes values, and buffers again once space is back.
- **A corrupt file** is moved aside (`buffer.sqlite.corrupt-<time>`) and a new one started. Its rows were values the broker never got; delete it once you no longer need them.
- **Deleted while running:** the gateway restores it from its open connection, rows included.
- **Rows waiting** is on the status page and in `plenum_buffer_rows`.

To move a gateway to new hardware with values still waiting, stop the service and copy the file (and any `-wal` file next to it) to the same path on the new one.

## Logs

```bash
journalctl -u plenum-gateway -f
```

The gateway logs transitions, not states: a device that stops answering logs once when it starts failing and once when it recovers, with the reason; a broker outage the same. A quiet log is a healthy gateway. Warnings and errors name the device or point.

With Docker: `docker logs -f plenum`.

## Status page

With `status` in the config, `http://127.0.0.1:8080` on the gateway shows the broker, the outbox, every device with its health and latest values, and recent commands. It listens on loopback by default, so from a laptop:

```bash
ssh -L 8080:127.0.0.1:8080 pi@gateway
```

and open `http://127.0.0.1:8080`. `GET /api/status` serves the same as JSON.

## Health on MQTT

The gateway keeps a retained message on `site/building/$gateway/<id>/health`: `online` with every device's status and last successful read, refreshed every `healthIntervalMs`, and `offline` (its MQTT last will) when it stops or loses the broker. Alert on that topic from whatever reads the broker.

## Telemetry

With the standard OpenTelemetry variables in `/etc/plenum/gateway.env`, the gateway sends traces, metrics and logs over OTLP; without them, nothing. See [observability/README.md](../observability/README.md) for the variables, the dashboard and the Grafana Cloud free-plan budget.

## Uninstall

```bash
sudo systemctl disable --now plenum-gateway
```

```bash
sudo rm -rf /opt/plenum /etc/systemd/system/plenum-gateway.service
```

Then remove `/etc/plenum` (config and secrets) and `/var/lib/plenum` (the outbox) if you no longer need them, and the user with `sudo userdel plenum`.
