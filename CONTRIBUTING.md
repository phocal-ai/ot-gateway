# Contributing to OT Gateway

Thanks for your interest! OT Gateway is early, so issues, design feedback and pull requests are all welcome.

## Setup

```bash
pnpm install
pnpm check
```

You need Node.js 22.18 or newer (24 LTS recommended) and pnpm 10.

## Ground rules

- Read [docs/VISION.md](docs/VISION.md) and [CLAUDE.md](CLAUDE.md). CLAUDE.md lists the coding rules for humans and AI assistants alike.
- OT Gateway is Effect-native. Please don't add runtime dependencies outside the Effect ecosystem without opening an issue first.
- Protocol code comes with tests built from spec examples or captured traffic, and a simulator where it makes sense.
- Keep pull requests focused. Explain the field scenario a change addresses if there is one.

## Branches

- `dev` is the integration branch. Branch off `dev` and open pull requests against `dev`.
- `main` holds releases only. It moves forward when `dev` is merged into it for a release, and each release is tagged on `main` (`vX.Y.Z`).
- Pushing the tag publishes the image (`.github/workflows/image.yml`), only when the tagged commit is on `main`, and builds it from the tagged source without the pull requests' build cache. A plain `vX.Y.Z` also moves `:latest`; a prerelease such as `v0.7.0-rc.1` does not.
- A release also moves the default tag in `packaging/compose.yaml` (`OT_GATEWAY_TAG`), the `docker run` example in `docs/operations.md` and the tag in the commands of `docs/raspberry-pi-install.md` and `docs/raspberry-pi-testing.md` to the new tag.
- The first release under a new image name (v0.6.0, `ghcr.io/phocal-ai/ot-gateway`) creates a new, private package: make it public in the package's settings (the organization must allow public packages for that moment), then check `docker pull` without logging in.
- Urgent fixes for a release branch off `main`, merge back into `main`, then get merged into `dev` so the two don't drift.
- Name working branches by intent, e.g. `feat/modbus-batching`, `fix/mqtt-reconnect`, `docs/topics`.

CI runs `pnpm check` on every pull request into `dev` or `main` and on every push to them.

## Commit messages

Use short, imperative subjects, such as `modbus: group adjacent registers into one read`. Prefix with the package name when a change is scoped to one package.

## Interop

The unit tests and the simulation talk to our own test broker and device simulators, so a spec misread the same way on both sides would pass them. `scripts/interop.sh` runs `apps/gateway/test/interop` against implementations that are not ours: Mosquitto 2 and EMQX 5 (the client, and the whole gateway with commands), the BACnet Stack demo server (discovery, ReadPropertyMultiple, WriteProperty with priority, change of value) and a pymodbus server (every table and type, writes). It needs Docker and Python 3; `scripts/interop.sh mqtt` runs one peer. The `Interop` workflow runs it on pull requests that touch the code.

## Simulation

`apps/gateway/test/Simulation.test.ts` runs the whole gateway (pipelines, outbox, MQTT client, Modbus and BACnet drivers) against the test broker and device simulators on an in-memory network (`MemoryNetwork` in `@ot-gateway/core`) under the test clock. A seeded schedule crashes and partitions the broker, the devices and the gateway's host, loses datagrams, restarts the gateway, fills the outbox's disk under it and steps its wall clock (as NTP does on a Pi, backwards too). At the end it checks that no accepted value was lost, values arrived in order (except values that skipped a full disk's outbox), duplicates stayed within the in-flight window, the outbox drained, no point went quiet while nothing on its path was failing, every device is ok, no socket leaked and warnings stayed within the log budget. `pnpm test` runs three seeds of six hours (about 30 seconds); a week per seed takes about four minutes:

```bash
SIM_SEEDS=7,8 SIM_HOURS=168 pnpm --filter @ot-gateway/gateway sim
```

A failing run prints its seed, and the same seed replays the same faults. The `Soak` workflow simulates a week for five new seeds every night. Write a regression as a seed and an assertion, not a sleep.

## Soak

What a soak finds depends on how many events happen (poll cycles, outages, COV renewals, buffer fills and drains), not on how many hours pass. Only the target hardware needs real time. So there are two presets, and neither runs all the time:

| Preset   | Command                    | What it is                                                                                                   | When                                                                                      |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Quick    | `scripts/soak.sh quick`    | 10 minutes at speed 60, four copies of every device, disk faults: about 10 hours of events, 4 broker outages | Every release: the `Soak` workflow runs it on the pull request into `main`                |
| Extended | `scripts/soak.sh extended` | 12 hours in real time with `SOAK_STRICT_HOST=1`, on a Raspberry Pi                                           | A release that changes a driver, the pipeline, the buffer, MQTT or packaging; before v1.0 |

Run the quick preset yourself on a branch that changes a driver, the pipeline, the buffer or MQTT. A preset only sets defaults, so `SOAK_DEVICES=2 scripts/soak.sh quick` still works, and any duration still runs: `SOAK_SPEED=60 SOAK_DEVICES=4 scripts/soak.sh 30m` packs about a day of outages into half an hour.

At speed 60, every interval in `examples/gateway.json` is divided by 60 (polls at least 100 ms apart, COV lifetimes at least 30 s), the broker stops every two minutes and the devices every four. `SOAK_DISK_FAULT=1` also fills the buffer's disk (a disk image on macOS, a tmpfs on Linux, which needs root or passwordless sudo). The run ends without outages so the buffer can drain, and fails if the gateway exits or logs FATAL, a device is not ok in the last health message, rows are left in the buffer, or memory or open files grow from the first half of the run to the second. A run stopped early skips that drain, so it cannot pass the backlog check. The script header lists every setting.

The `Soak` workflow simulates every night and runs the 30-minute soak and an arm64 soak every Sunday. The arm64 one runs inside the container image under QEMU, held to two cores and 1 GB: it shows the ARM build and the memory and CPU headroom, not the SD card or heat.

The extended preset is for the hardware: SD card, CPU, thermal throttling, NTP steps. `SOAK_STRICT_HOST=1` also fails on an event-loop stall or a power or thermal condition (under-voltage only on Raspberry Pi kernel 6.12 and later, see docs/operations.md, "The machine"). Twelve hours is half a day of SD-card writes, NTP corrections and COV renewals at their real rate, five broker outages, and a sample every ten minutes for the growth checks. [docs/raspberry-pi-testing.md](docs/raspberry-pi-testing.md) has the procedure and the pass criteria. A release that changes none of those paths, such as config validation, docs or CI, needs only the quick preset.

## Reporting device quirks

Real devices deviate from specs. If you hit one, open an issue with the device make and model, the firmware version, and a packet capture if you can. Those reports are gold.
