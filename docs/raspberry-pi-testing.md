# Testing on a Raspberry Pi

The simulation and the accelerated soak find what a fault schedule can find, on a laptop or in CI. What they cannot find is the hardware: a slow SD card, an under-powered USB supply, heat in a closed cabinet, a clock that starts in 1970 and is set by NTP minutes later, the CPU of a small ARM board. This is how to test a gateway on a Pi before it goes into a building, and what has to be true to call it ready.

A Raspberry Pi 4 on an SD card is the low end of where Plenum runs. What runs well there for a week runs well on an industrial PC.

## What you need

- **A Raspberry Pi 4 Model B** (2 GB or more) or a Pi 5, with the official power supply, a case with a heatsink and Ethernet.
- **An SD card on purpose** (32 GB, A1 or A2 class): most installs will run on one. A USB SSD is a later comparison, not the test.
- **The 64-bit Raspberry Pi OS Lite** (Bookworm or later). The image is arm64 only; it does not start on the 32-bit OS.
- **Something to talk to.** In order of how much it proves:
  1. Nothing extra: the soak runs the broker and simulated devices on the Pi itself.
  2. The bench on a second machine (`node apps/gateway/src/bench.ts` with your config), so requests cross a real network.
  3. Real devices: a Modbus TCP meter; a Modbus RTU meter behind an RS-485-to-TCP gateway, which is what most buildings have and where `requestGapMs` and `maxRegistersPerRead` matter; a BACnet/IP controller, or the BACnet Stack server on another Pi (`scripts/interop.sh bacnet` shows how to run it).
- **Optionally a smart plug** to cut power on a schedule for the power-loss test.

## Prepare the Pi

1. Flash the 64-bit Lite image with Raspberry Pi Imager. Set a hostname, your SSH key and the time zone there; leave everything else at its default. Do not add a real-time clock: booting with the wrong time is part of the test.
2. Update and install Docker:

   ```bash
   sudo apt update && sudo apt full-upgrade -y
   ```

   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER"
   ```

3. Note the baseline: no power or thermal conditions (`0x0`), and the idle temperature.

   ```bash
   vcgencmd get_throttled; vcgencmd measure_temp
   ```

4. **Remote access** for a Pi that is not on your desk: Tailscale (or any VPN you already use) gives SSH and the status page through `ssh -L 8080:127.0.0.1:8080 pi@<name>`. Do not open the status page to the network.
5. **Telemetry** (recommended for the long runs): put the `OTEL_*` variables from `observability/README.md` in `/etc/plenum/gateway.env`, with `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=pi-test`, and filter the dashboard's Environment to it. A test gateway with a few devices adds about 100 series to the free plan's 10,000.
6. **The image to test.** A release (`ghcr.io/phocal-ai/plenum-gateway:<tag>`), or a build of the branch under test. Build on your laptop and copy it over, which is faster than building on the Pi:

   ```bash
   docker buildx build --platform linux/arm64 --build-arg PLENUM_VERSION="$(git describe --tags --always --dirty)" -t plenum-gateway:test --load .
   ```

   ```bash
   docker save plenum-gateway:test | ssh pi@<name> docker load
   ```

## The tests, in order

Stop at the first one that fails, fix it, and start that test again.

### 1. Smoke, 15 minutes

Install with Compose as in [operations.md](operations.md) (`PLENUM_TAG`, or `image:` set to `plenum-gateway:test`), with your config or `examples/gateway.json` against the bench on a second machine. On the status page:

- every device `ok`, values moving;
- the **Host** card shows the version you installed, a temperature and no conditions;
- `docker logs plenum` has no warnings.

### 2. Accelerated soak on the Pi, 1 hour

Everything in one container: broker, simulated devices and the gateway, about a day of outages in an hour. Stop the gateway first, since the soak needs its ports.

```bash
docker compose -f packaging/compose.yaml down
```

```bash
docker run --rm --user root -v /var/tmp/soak:/soak -e SOAK_DIR=/soak \
  -e SOAK_SPEED=20 -e SOAK_DEVICES=4 -e SOAK_STRICT_HOST=1 \
  --entrypoint bash plenum-gateway:test scripts/soak.sh 1h
```

`/var/tmp/soak/summary.txt` must end in `verdict: PASS`. With `SOAK_STRICT_HOST=1` that includes no event-loop stall and no power or thermal condition.

### 3. Disk faults, 1 hour

The same with a 16 MB disk for the outbox that fills during every third outage. Mounting it needs privileges, so this test (and never the gateway itself) runs privileged:

```bash
docker run --rm --privileged --user root -v /var/tmp/soak-disk:/soak -e SOAK_DIR=/soak \
  -e SOAK_SPEED=20 -e SOAK_DISK_FAULT=1 -e SOAK_STRICT_HOST=1 \
  --entrypoint bash plenum-gateway:test scripts/soak.sh 1h
```

### 4. Real-time soak, 24 hours, then 7 days

The release gate: the soak at speed 1, so every timer, NTP correction and SD-card write happens at its real rate.

```bash
docker run -d --name soak --user root -v /var/tmp/soak-24h:/soak -e SOAK_DIR=/soak \
  -e SOAK_DEVICES=4 -e SOAK_STRICT_HOST=1 \
  --entrypoint bash plenum-gateway:test scripts/soak.sh 24h
```

Read `docker logs soak` and `/var/tmp/soak-24h/summary.txt` at the end. Then run the gateway itself with Compose against the bench or real devices for a week, with telemetry on, and read the dashboard's **Host** row against the criteria below.

### 5. Power loss, 20 times

Pull the plug (or switch the smart plug) while the gateway is writing its outbox: stop the broker first so values are being buffered, wait a minute, cut power, wait ten seconds, restore it. Repeat 20 times, some during boot. After each:

- the gateway is back within 60 seconds of boot, every device `ok` within two poll intervals;
- `docker logs plenum` shows no crash loop. A `corrupt` outbox moved aside is acceptable but should be rare; a gateway that does not start is not;
- once the broker is back, the outbox drains.

### 6. Network and clock

- **Uplink down for an hour** (unplug Ethernet with devices on another interface, or stop the broker): values are buffered and delivered in order afterwards.
- **Boot without network**, then connect it: the clock starts wrong. Expect exactly one `wall clock stepped` warning when NTP sets it, a step in timestamps, and no device failures or reconnects from it.
- **Device link flapping**: unplug a Modbus device for five minutes. One warning when it fails, one line when it recovers.

### 7. Heat

An hour in a closed box or cabinet without the heatsink, or with `stress-ng --cpu 4` beside the gateway. This proves the warnings work: expect `host is hot` and a `soft_temperature_limit` or `throttled` condition on the status page, in the health message and on the dashboard. The gateway itself should keep every device `ok`.

## Pass criteria

| What            | Pass                                                                                                          | Where to read it                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Memory          | Levels off within an hour; no growth over the 24 hours (the soak's growth check), well under the 768 MB limit | Status page, `plenum_process_memory_bytes`, soak summary                |
| Event loop      | p99 under 50 ms; no `event loop stalled`                                                                      | `plenum_event_loop_lag_seconds`, soak summary                           |
| CPU             | Under 10% of one core for a few devices polled every 5 s                                                      | `plenum_process_cpu_seconds_total`, status page                         |
| Power and heat  | No conditions during tests 1–6, temperature under 70 °C in its case                                           | Status page, `plenum_host_throttled`, `plenum_host_temperature_celsius` |
| Storage writes  | Near zero while the broker is up; bounded during outages                                                      | `plenum_process_disk_written_bytes_total`                               |
| Outbox          | Drains after every outage; nothing lost (soak checks order and backlog)                                       | Soak summary, `plenum_buffer_rows`                                      |
| Clock           | One step after a boot without network, none otherwise                                                         | `plenum_clock_steps_total`, the log                                     |
| Open files      | Flat                                                                                                          | `plenum_process_open_fds`, soak summary                                 |
| Restarts        | None, other than the power cuts                                                                               | `plenum_process_start_time_seconds`                                     |
| Device requests | Mean request time steady; no unexplained refusals                                                             | Dashboard "Mean request time by device"                                 |

## Reporting

Keep each test's `summary.txt`, `docker logs` and a screenshot of the dashboard's Host row, with the Pi model, the SD card's make and size, the power supply and the image version. Anything that fails is an issue labeled `pi-test`, with those attached.

## Known gap

Several serial devices behind one Modbus RTU-to-TCP gateway each open their own TCP connection to it, and many of those gateways accept only one or two. Until the gateway shares one connection per `host:port`, test real RS-485 meters one per gateway, or expect connection refusals beyond the first.
