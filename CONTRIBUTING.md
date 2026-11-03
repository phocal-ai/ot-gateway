# Contributing to Plenum

Thanks for your interest! Plenum is early, so issues, design feedback and pull requests are all welcome.

## Setup

```bash
pnpm install
pnpm check
```

You need Node.js 22.18 or newer (24 LTS recommended) and pnpm 10.

## Ground rules

- Read [docs/VISION.md](docs/VISION.md) and [CLAUDE.md](CLAUDE.md). CLAUDE.md lists the coding rules for humans and AI assistants alike.
- Plenum is Effect-native. Please don't add runtime dependencies outside the Effect ecosystem without opening an issue first.
- Protocol code comes with tests built from spec examples or captured traffic, and a simulator where it makes sense.
- Keep pull requests focused. Explain the field scenario a change addresses if there is one.

## Branches

- `dev` is the integration branch. Branch off `dev` and open pull requests against `dev`.
- `main` holds releases only. It moves forward when `dev` is merged into it for a release, and each release is tagged on `main` (`vX.Y.Z`).
- Urgent fixes for a release branch off `main`, merge back into `main`, then get merged into `dev` so the two don't drift.
- Name working branches by intent, e.g. `feat/modbus-batching`, `fix/mqtt-reconnect`, `docs/topics`.

CI runs `pnpm check` on every pull request into `dev` or `main` and on every push to them.

## Commit messages

Use short, imperative subjects, such as `modbus: group adjacent registers into one read`. Prefix with the package name when a change is scoped to one package.

## Soak testing

Changes to drivers, the pipeline, the buffer or MQTT should survive a soak run. What a soak finds depends on how many events happen (poll cycles, outages, COV renewals, buffer fills and drains), not on how many hours pass, so run it accelerated:

```bash
SOAK_SPEED=60 SOAK_DEVICES=4 scripts/soak.sh 30m
```

That packs roughly a day of outages and renewals into half an hour: every interval in `examples/gateway.json` is divided by 60 (polls at least 100 ms apart, COV lifetimes at least 30 s), the broker stops every two minutes and the devices every four, and every device runs four times on its own ports. `SOAK_DISK_FAULT=1` also fills the buffer's disk (a disk image on macOS, a tmpfs on Linux, which needs root or passwordless sudo). The run ends without outages so the buffer can drain, and fails if the gateway exits or logs FATAL, a device is not ok in the last health message, rows are left in the buffer, or memory or open files grow from the first half of the run to the second. The script header lists every setting. The `Soak` workflow runs the same thing every night and on demand.

Real time only matters on the target hardware (SD card, CPU, thermal throttling, NTP steps), so before a release, run a real-time soak on a Raspberry Pi:

```bash
scripts/soak.sh 24h
```

## Reporting device quirks

Real devices deviate from specs. If you hit one, open an issue with the device make and model, the firmware version, and a packet capture if you can. Those reports are gold.
