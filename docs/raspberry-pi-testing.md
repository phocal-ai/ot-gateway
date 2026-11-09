# Testing on a Raspberry Pi

The simulation and the accelerated soak find what a fault schedule can find, on a laptop or in CI. What they cannot find is the hardware: a slow SD card, an under-powered USB supply, heat in a closed cabinet, a clock that starts in 1970 and is set by NTP minutes later, the CPU of a small ARM board. This is how to test a gateway on a Pi before it goes into a building, and what has to be true to call it ready.

A Raspberry Pi 4 on an SD card is the low end of where OT Gateway runs. What runs well there runs well on an industrial PC.

## What you need

- **A Raspberry Pi 4 Model B** (2 GB or more) or a Pi 5, with the official power supply, a case with a heatsink and Ethernet.
- **An SD card on purpose** (32 GB, A1 or A2 class): most installs will run on one. A USB SSD is a later comparison, not the test.
- **The 64-bit Raspberry Pi OS Lite** (Bookworm or later). The image is arm64 only; it does not start on the 32-bit OS.
- **Something to talk to.** In order of how much it proves:
  1. Nothing extra: the soak runs the broker and simulated devices on the Pi itself.
  2. A broker on a second machine (Mosquitto, or the one you will use), so MQTT crosses a real network. The bench cannot stand in for it there: it serves only `localhost`.
  3. Real devices: a Modbus TCP meter; a Modbus RTU meter behind an RS-485-to-TCP gateway, which is what most buildings have and where `requestGapMs` and `maxRegistersPerRead` matter; a BACnet/IP controller, or the BACnet Stack server on another Pi (`scripts/interop.sh bacnet` shows how to run it).
- **Optionally a smart plug** to cut power on a schedule for the power-loss test.

## Prepare the Pi

1. Flash the 64-bit Lite image with Raspberry Pi Imager. Set a hostname, your SSH key and the time zone there; leave everything else at its default. Do not add a real-time clock: booting with the wrong time is part of the test. [raspberry-pi-install.md](raspberry-pi-install.md) walks through this and steps 2 and 3 from a blank SD card, including turning on the memory limits Docker needs.
2. Update and install Docker:

   ```bash
   sudo apt update && sudo apt full-upgrade -y
   ```

   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER"
   ```

3. Note the baseline: no power or thermal conditions (`0x0`), no under-voltage in the kernel log, and the idle temperature. `vcgencmd` shows only the last two seconds (the kernel clears the flags that often); the kernel log is the record since boot.

   ```bash
   vcgencmd get_throttled; vcgencmd measure_temp; journalctl -k -g voltage
   ```

4. **Remote access** for a Pi that is not on your desk: Tailscale (or any VPN you already use) gives SSH and the status page through `ssh -L 8080:127.0.0.1:8080 pi@<name>`. Do not open the status page to the network.
5. **Telemetry** (recommended for the long runs): put the `OTEL_*` variables from `observability/README.md` in `/etc/ot-gateway/gateway.env`, with `OTEL_RESOURCE_ATTRIBUTES=service.namespace=ot-gateway,deployment.environment=pi-test` (the dashboard shows only `service.namespace=ot-gateway`), and filter the dashboard's Environment to it. A test gateway with a few devices adds about 100 series to the free plan's 10,000.
6. **The image to test.** A release (`ghcr.io/phocal-ai/ot-gateway:<tag>`), or a build of the branch under test. Build on your laptop and copy it over, which is faster than building on the Pi:

   ```bash
   docker buildx build --platform linux/arm64 --build-arg OT_GATEWAY_VERSION="$(git describe --tags --always --dirty)" -t ot-gateway:test --load .
   ```

   ```bash
   docker save ot-gateway:test | ssh pi@<name> docker load
   ```

## The tests, in order

Stop at the first one that fails, fix it, and start that test again.

### 1. Smoke, 15 minutes

Install with Compose as in [raspberry-pi-install.md](raspberry-pi-install.md) (the tag in `compose.yaml`, or `image:` set to `ot-gateway:test`), with your config and real devices. Without hardware, use `examples/gateway.json` and run the bench on the Pi next to the gateway, from the same image: it serves a test broker and simulated Modbus and BACnet devices, on `localhost` only. Start it before the gateway, so the gateway finds its broker at once:

```bash
IMAGE=ghcr.io/phocal-ai/ot-gateway:v0.10.0      # or ot-gateway:test
docker run -d --name ot-gateway-bench --network host --log-driver local --restart unless-stopped \
  --entrypoint node $IMAGE apps/gateway/src/bench.ts examples/gateway.json
```

It reads the example config inside the image, so there is nothing to copy and no `sudo`. The gateway takes the same config, from its folder (`~/ot-gateway`, with `compose.yaml`): `docker run --rm --entrypoint cat $IMAGE examples/gateway.json > ot-gateway.json`, then `docker compose up -d`.

Like the gateway, it comes back after a reboot, so a Pi that restarts doesn't show its devices as failing. Remove it when the smoke test is done (`docker rm -f ot-gateway-bench`): the soak brings its own broker and devices, on the same ports.

On the status page:

- every device `ok`, values moving;
- the header shows the version you installed, and no notice about the machine sits above the cards (`/api/status` has the temperature and `throttled.now` is empty);
- `docker logs ot-gateway` has no warnings.

### 2. Accelerated soak on the Pi, 1 hour

Everything in one container: broker, simulated devices and the gateway, about a day of outages in an hour. Stop the gateway first, since the soak needs its ports.

```bash
docker compose -f packaging/compose.yaml down
```

```bash
docker run --rm --user root -v /var/tmp/soak:/soak -e SOAK_DIR=/soak \
  -e SOAK_SPEED=20 -e SOAK_DEVICES=4 -e SOAK_STRICT_HOST=1 \
  --entrypoint bash ot-gateway:test scripts/soak.sh 1h
```

`/var/tmp/soak/summary.txt` must end in `verdict: PASS`. With `SOAK_STRICT_HOST=1` that includes no event-loop stall and no power or thermal condition.

### 3. Disk faults, 1 hour

The same with a 16 MB disk for the outbox that fills during every third outage. Mounting it needs privileges, so this test (and never the gateway itself) runs privileged:

```bash
docker run --rm --privileged --user root -v /var/tmp/soak-disk:/soak -e SOAK_DIR=/soak \
  -e SOAK_SPEED=20 -e SOAK_DISK_FAULT=1 -e SOAK_STRICT_HOST=1 \
  --entrypoint bash ot-gateway:test scripts/soak.sh 1h
```

### 4. Real-time soak, 12 hours

The extended preset: the soak at speed 1, so every timer, NTP correction and SD-card write happens at its real rate. A release needs it when it changes a driver, the pipeline, the buffer, MQTT or packaging, and before v1.0 (CONTRIBUTING.md, "Soak"); other releases ship on the quick preset in CI.

```bash
docker run -d --name soak --user root -v /var/tmp/soak-12h:/soak -e SOAK_DIR=/soak \
  -e SOAK_DEVICES=4 \
  --entrypoint bash ot-gateway:test scripts/soak.sh extended
```

Read `docker logs soak` and `/var/tmp/soak-12h/summary.txt` at the end, then `docker rm soak` before the next run. Before a Pi goes into its first building, also run the gateway itself with Compose against the bench or real devices for a week, with telemetry on, and read the dashboard's **Host** row against the criteria below; a release does not wait for that week.

### 5. Power loss, 20 times

Pull the plug (or switch the smart plug) while the gateway is writing its outbox: stop the broker first so values are being buffered, wait a minute, cut power, wait ten seconds, restore it. Repeat 20 times, some during boot. After each:

- the gateway is back within 60 seconds of boot, every device `ok` within two poll intervals;
- `docker logs ot-gateway` shows no crash loop. A `corrupt` outbox moved aside is acceptable but should be rare; a gateway that does not start is not;
- once the broker is back, the outbox drains.

### 6. Network and clock

- **Uplink down for an hour** (unplug Ethernet with devices on another interface, or stop the broker): values are buffered and delivered in order afterwards.
- **Boot without network**, then connect it: the clock starts wrong. Expect exactly one `wall clock stepped` warning when NTP sets it, a step in timestamps, and no device failures or reconnects from it.
- **Device link flapping**: unplug a Modbus device for five minutes. One warning when it fails, one line when it recovers.

### 7. Heat

An hour in a closed box or cabinet without the heatsink, or with `stress-ng --cpu 4` beside the gateway. This proves the warnings work: expect `host is hot` and a `soft_temperature_limit` or `throttled` condition in `/api/status`, the health message and on the dashboard, and a notice at the top of the status page that the Pi slows itself down. On Raspberry Pi OS 13 and other kernels from 6.12 on the gateway cannot see those two: expect `host is hot` and the temperature, and check `vcgencmd get_throttled` on the Pi while it is hot. The gateway itself should keep every device `ok`.

## Pass criteria

| What            | Pass                                                                                                          | Where to read it                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Memory          | Levels off within an hour; no growth over the 12 hours (the soak's growth check), well under the 768 MB limit | Status page, `ot_gateway_process_memory_bytes`, soak summary                                                |
| Event loop      | p99 under 50 ms; no `event loop stalled`                                                                      | `ot_gateway_event_loop_lag_seconds`, soak summary                                                           |
| CPU             | Under 10% of one core for a few devices polled every 5 s                                                      | `ot_gateway_process_cpu_seconds_total`, status page                                                         |
| Power and heat  | No conditions during tests 1–6, no `Undervoltage detected!` in the kernel log, under 70 °C in its case        | Status page, `ot_gateway_host_throttled`, `ot_gateway_host_temperature_celsius`, `journalctl -k -g voltage` |
| Storage writes  | Near zero while the broker is up; bounded during outages                                                      | `ot_gateway_process_disk_written_bytes_total`                                                               |
| Outbox          | Drains after every outage; nothing lost (soak checks order and backlog)                                       | Soak summary, `ot_gateway_buffer_rows`                                                                      |
| Clock           | One step after a boot without network, none otherwise                                                         | `ot_gateway_clock_steps_total`, the log                                                                     |
| Open files      | Flat                                                                                                          | `ot_gateway_process_open_fds`, soak summary                                                                 |
| Restarts        | None, other than the power cuts                                                                               | `ot_gateway_process_start_time_seconds`                                                                     |
| Device requests | Mean request time steady; no unexplained refusals                                                             | Dashboard "Mean request time by device"                                                                     |

## Reporting

Keep each test's `summary.txt`, `docker logs` and a screenshot of the dashboard's Host row, with the Pi model, the SD card's make and size, the power supply and the image version. Anything that fails is an issue labeled `pi-test`, with those attached.

## Several meters behind one gateway

Put two or more RS-485 meters behind one RTU-to-TCP gateway, each its own device in the config with the gateway's `host` and `port` and its own `unitId`. They share one TCP connection (`devices share one connection` in the log). Disconnect one meter from the bus: the others stay `ok`, and the gateway keeps its connection.
