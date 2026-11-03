#!/usr/bin/env bash
# Soak test: the gateway against the bench, with faults injected.
#
#   scripts/soak.sh [duration]                      # 24h by default: 24h, 90m, 600s, or hours
#   SOAK_SPEED=60 scripts/soak.sh 30m               # about a day of events in half an hour
#
# What a soak finds depends on how many events happen (poll cycles, outages,
# COV renewals, buffer fills and drains), not on how long it runs. Real time
# only matters on the target hardware (SD card, CPU, NTP), so on a laptop or in
# CI run it accelerated and keep the real-time run for the Raspberry Pi.
#
# - Runs the MQTT test broker, the simulated devices and the gateway as three
#   processes started from SOAK_CONFIG (default examples/gateway.json), with
#   change of value turned on for every BACnet device.
# - SOAK_SPEED=N (default 1) runs N times faster: poll intervals, the health
#   interval, the COV lifetime, the simulated values and the fault schedule are
#   all divided by N. Polls stay at least 100 ms apart, COV lifetimes at least
#   30 s and outages at least 10 s long, so no fault is shorter than a reconnect.
#   A compressed run puts more pressure on concurrency than the field does,
#   which is the point, but a device whose requests take longer than its
#   compressed interval only shows that it is slow.
# - SOAK_DEVICES=N (default 1) runs N copies of every device, each on its own
#   port and BACnet device instance.
# - Every OUTAGE_EVERY seconds (default 2 h / SOAK_SPEED) the broker stops for
#   OUTAGE_FOR seconds (default 60 s / SOAK_SPEED, at least 10), so the buffer
#   fills and drains. Every second outage also stops the devices, so reads
#   fail, recover and COV resubscribes.
# - SOAK_DISK_FAULT=1 puts the buffer on a 16 MB disk (a disk image on macOS,
#   a tmpfs on Linux, which needs root or passwordless sudo) and fills the disk
#   during every third outage.
# - Every SAMPLE_EVERY seconds (default 10 min / SOAK_SPEED, at least 5 s) it
#   records memory, CPU, open files and the buffer size of the gateway in
#   samples.csv. The buffer's rows are counted once the gateway has stopped
#   (it holds the file locked while it runs).
# - No outage ends within the last SOAK_DRAIN seconds (default 180 s /
#   SOAK_SPEED, at least 60), so the run ends with the buffer drained.
#
# The run fails (exit 1) when the gateway exits or logs FATAL, when the last
# health message does not show every device ok, when more than SOAK_MAX_BACKLOG
# rows (default 1000) are still buffered when it stops, or when memory or open
# files grow from the first half of the run to the second by more than
# SOAK_MAX_RSS_GROWTH (default 1.5 times) or SOAK_MAX_FD_GROWTH (default 16).
#
# Processes are tracked by PID and only those are stopped. Results go to
# SOAK_DIR (default $TMPDIR/plenum-soak-<time>). The gateway loads the same env
# file as `pnpm gateway`, so its telemetry reaches the configured backend.
set -euo pipefail

duration=${1:-24h}
if [[ ! $duration =~ ^[0-9]+[hms]?$ ]]; then
  echo "duration is a number of hours, or a number with h, m or s: 24h, 90m, 600s" >&2
  exit 2
fi
case $duration in
  *h) seconds=$((${duration%h} * 3600)) ;;
  *m) seconds=$((${duration%m} * 60)) ;;
  *s) seconds=${duration%s} ;;
  *) seconds=$((duration * 3600)) ;;
esac
seconds=${SOAK_SECONDS:-$seconds}
speed=${SOAK_SPEED:-1}
copies=${SOAK_DEVICES:-1}
if [[ ! $speed =~ ^[1-9][0-9]*$ || ! $copies =~ ^[1-9][0-9]*$ ]]; then
  echo "SOAK_SPEED and SOAK_DEVICES are whole numbers of at least 1" >&2
  exit 2
fi
at_least() { echo $(($1 > $2 ? $1 : $2)); }

repo=$(cd "$(dirname "$0")/.." && pwd)
source_config=${SOAK_CONFIG:-$repo/examples/gateway.json}
dir=${SOAK_DIR:-${TMPDIR:-/tmp}/plenum-soak-$(date +%Y%m%dT%H%M%S)}
outage_every=${OUTAGE_EVERY:-$((7200 / speed))}
outage_for=${OUTAGE_FOR:-$(at_least $((60 / speed)) 10)}
sample_every=${SAMPLE_EVERY:-$(at_least $((600 / speed)) 5)}
drain=${SOAK_DRAIN:-$(at_least $((180 / speed)) 60)}
env_file=${PLENUM_ENV_FILE:-$HOME/.config/phocal/plenum-gateway.env}
mkdir -p "$dir"
log() { echo "$(date +%FT%T) $*" | tee -a "$dir/events.log"; }

as_root=""
[[ $(id -u) != 0 ]] && as_root="sudo -n"
buffer_dir=$dir
volume=""
if [[ ${SOAK_DISK_FAULT:-0} == 1 ]]; then
  case $(uname) in
    Darwin)
      hdiutil create -quiet -size 16m -fs HFS+ -volname plenum-soak "$dir/disk.dmg"
      volume=$(hdiutil attach -nobrowse "$dir/disk.dmg" | awk -F'\t' '/plenum-soak/ {print $NF}')
      ;;
    Linux)
      volume=$dir/disk
      mkdir -p "$volume"
      if ! $as_root mount -t tmpfs -o size=16m,mode=1777 plenum-soak "$volume"; then
        echo "SOAK_DISK_FAULT on Linux mounts a tmpfs: run as root or with passwordless sudo" >&2
        exit 1
      fi
      ;;
    *)
      echo "SOAK_DISK_FAULT needs macOS or Linux" >&2
      exit 1
      ;;
  esac
  buffer_dir=$volume
fi
# Explicit `return 0`s: in an EXIT trap a bare `return` returns the exit status, which `set -e` takes as a failure.
detach_volume() {
  [[ -z $volume ]] && return 0
  case $(uname) in
    Darwin) hdiutil detach -quiet "$volume" || true ;;
    Linux) $as_root umount "$volume" || true ;;
  esac
  volume=""
}

# The soak's config: the source config with every interval divided by the speed, and the copies of every device.
config=$dir/gateway.json
node -e '
  const fs = require("fs")
  const [source, target, buffer, speedText, copiesText] = process.argv.slice(1)
  const speed = Number(speedText)
  const copies = Number(copiesText)
  const config = JSON.parse(fs.readFileSync(source, "utf8"))
  config.buffer = { ...config.buffer, path: buffer }
  if (speed > 1) {
    config.healthIntervalMs = Math.max(1000, Math.round((config.healthIntervalMs ?? 60000) / speed))
    const lifetime = config.bacnet?.covLifetimeSeconds ?? 300
    config.bacnet = { ...config.bacnet, covLifetimeSeconds: Math.max(30, Math.round(lifetime / speed)) }
  }
  const sped = (device) => {
    const copy = structuredClone(device)
    if (copy.protocol === "bacnet-ip") copy.cov = true
    if (speed > 1) {
      copy.pollIntervalMs = Math.max(100, Math.round((copy.pollIntervalMs ?? 5000) / speed))
      if (copy.protocol === "simulator") {
        for (const point of copy.points) point.periodSeconds = Math.max(1, (point.periodSeconds ?? 60) / speed)
      }
    }
    return copy
  }
  // Copies get the next free port and device instance, never the gateway own BACnet port.
  const bacnetPort = (device) => Number((device.address ?? "").split(":")[1] ?? 47808)
  const ports = { "modbus-tcp": new Set(), "bacnet-ip": new Set([config.bacnet?.port ?? 47808]) }
  const instances = new Set()
  for (const device of config.devices) {
    if (device.protocol === "modbus-tcp") ports["modbus-tcp"].add(device.port ?? 502)
    if (device.protocol === "bacnet-ip") {
      ports["bacnet-ip"].add(bacnetPort(device))
      instances.add(device.deviceInstance)
    }
  }
  const next = (taken, from) => {
    let value = from
    while (taken.has(value)) value++
    taken.add(value)
    return value
  }
  const devices = config.devices.map(sped)
  for (let copy = 2; copy <= copies; copy++) {
    for (const device of config.devices) {
      const extra = { ...sped(device), id: `${device.id}-${copy}` }
      if (device.protocol === "modbus-tcp") extra.port = next(ports["modbus-tcp"], device.port ?? 502)
      if (device.protocol === "bacnet-ip") {
        extra.deviceInstance = next(instances, device.deviceInstance)
        if (device.address !== undefined) {
          extra.address = `${device.address.split(":")[0]}:${next(ports["bacnet-ip"], bacnetPort(device))}`
        }
      }
      devices.push(extra)
    }
  }
  config.devices = devices
  fs.writeFileSync(target, JSON.stringify(config, null, 2))
' "$source_config" "$config" "$buffer_dir/buffer.sqlite" "$speed" "$copies"

broker=""
devices=""
gateway=""
start_broker() {
  node "$repo/apps/gateway/src/bench.ts" --only broker --speed "$speed" "$config" >>"$dir/broker.log" 2>&1 &
  broker=$!
}
start_devices() {
  node "$repo/apps/gateway/src/bench.ts" --only devices --speed "$speed" "$config" >>"$dir/devices.log" 2>&1 &
  devices=$!
}
stop_pid() {
  local pid=$1 signal=${2:-TERM}
  [[ -z $pid ]] && return 0
  kill "-$signal" "$pid" 2>/dev/null || return 0
  for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null || true
}
# Rows left in the buffer; only readable once the gateway has stopped, since it locks the file.
buffer_rows() {
  node --no-warnings -e '
    try {
      const { DatabaseSync } = require("node:sqlite")
      const db = new DatabaseSync(process.argv[1], { readOnly: true })
      console.log(db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n)
    } catch {
      console.log("")
    }
  ' "$buffer_dir/buffer.sqlite"
}
sample() {
  local rss cpu files bytes
  # /proc where there is one (slim container images have no ps), ps on macOS.
  if [[ -r /proc/$gateway/status ]]; then
    rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$gateway/status" 2>/dev/null || true)
  else
    rss=$(ps -o rss= -p "$gateway" | tr -d ' ' || true)
  fi
  cpu=$( (ps -o %cpu= -p "$gateway" 2>/dev/null || true) | tr -d ' ')
  if [[ -d /proc/$gateway/fd ]]; then
    files=$( (ls "/proc/$gateway/fd" 2>/dev/null || true) | wc -l | tr -d ' ')
  else
    files=$( (lsof -p "$gateway" 2>/dev/null || true) | wc -l | tr -d ' ')
  fi
  bytes=$( (cat "$buffer_dir"/buffer.sqlite* 2>/dev/null || true) | wc -c | tr -d ' ')
  echo "$(date +%FT%T),$rss,$cpu,$files,$bytes" >>"$dir/samples.csv"
}
# Pass or fail, from the samples, the logs, the last health message and the rows left in the buffer
# (the argument); writes verdict.txt.
check() {
  node -e '
    const fs = require("fs")
    const [dir, maxRssGrowth, maxFdGrowth, maxBacklog, rowsText] = process.argv.slice(1)
    const failures = []
    const lines = []
    const count = (level) => fs.readFileSync(`${dir}/gateway.log`, "utf8").split("\n").filter((line) => line.includes(`] ${level} (`)).length
    if (count("FATAL") > 0) failures.push(`the gateway logged ${count("FATAL")} FATAL line(s)`)

    const samples = fs.readFileSync(`${dir}/samples.csv`, "utf8").trim().split("\n").slice(1)
      .map((line) => line.split(","))
      .filter((row) => row[1] !== "")
      .map(([time, rss, cpu, files]) => ({ time, rss: Number(rss), files: Number(files) }))
    // The first fifth is warm-up (caches, connections, JIT); the rest is compared half against half.
    const steady = samples.slice(Math.max(1, Math.floor(samples.length / 5)))
    if (steady.length < 4) {
      lines.push(`growth:   not checked, ${samples.length} samples are too few`)
    } else {
      const half = Math.floor(steady.length / 2)
      const max = (rows, key) => Math.max(...rows.map((row) => row[key]))
      const rss = [max(steady.slice(0, half), "rss"), max(steady.slice(half), "rss")]
      const files = [max(steady.slice(0, half), "files"), max(steady.slice(half), "files")]
      lines.push(`rss kB:   ${rss[0]} in the first half, ${rss[1]} in the second (x${(rss[1] / rss[0]).toFixed(2)})`)
      lines.push(`files:    ${files[0]} in the first half, ${files[1]} in the second`)
      if (rss[1] > rss[0] * Number(maxRssGrowth)) failures.push(`memory grew more than x${maxRssGrowth}`)
      if (files[1] - files[0] > Number(maxFdGrowth)) failures.push(`open files grew by more than ${maxFdGrowth}`)
    }
    const backlog = rowsText === "" ? undefined : Number(rowsText)
    lines.push(`backlog:  ${backlog ?? "unknown"} row(s) left in the buffer`)
    if (backlog === undefined || backlog > Number(maxBacklog)) failures.push(`the buffer did not drain (${backlog ?? "unknown"} rows)`)

    const config = JSON.parse(fs.readFileSync(`${dir}/gateway.json`, "utf8"))
    const healthTopic = `${config.site}/${config.building}/$gateway/${config.id ?? "main"}/health `
    // The last message before the gateway was stopped; stopping it publishes offline.
    const last = fs.readFileSync(`${dir}/broker.log`, "utf8").split("\n")
      .findLast((line) => line.includes(healthTopic) && line.includes(`"status":"online"`))
    const health = last === undefined ? undefined : JSON.parse(last.slice(last.indexOf(healthTopic) + healthTopic.length))
    const notOk = config.devices.map((device) => device.id).filter((id) => health?.devices?.[id]?.status !== "ok")
    if (health === undefined) failures.push("the gateway never reported online")
    else if (notOk.length > 0) failures.push(`not ok in the last health message: ${notOk.join(", ")}`)
    else lines.push(`health:   online, all ${config.devices.length} device(s) ok`)

    lines.push(failures.length === 0 ? "verdict:  PASS" : `verdict:  FAIL\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
    fs.writeFileSync(`${dir}/verdict.txt`, lines.join("\n") + "\n")
    process.exit(failures.length === 0 ? 0 : 1)
  ' "$dir" "${SOAK_MAX_RSS_GROWTH:-1.5}" "${SOAK_MAX_FD_GROWTH:-16}" "${SOAK_MAX_BACKLOG:-1000}" "$1"
}
cleanup() {
  stop_pid "$gateway" INT
  stop_pid "$devices"
  stop_pid "$broker"
  gateway="" devices="" broker=""
  rm -f "$buffer_dir/fill"
  detach_volume
  log "soak stopped"
  summary
}
summary() {
  {
    echo "events:   $outages outage(s) in $(($(date +%s) - started)) s at speed $speed"
    echo "warnings: $(grep -cF '] WARN (' "$dir/gateway.log" || true)"
    echo "errors:   $(grep -cF '] ERROR (' "$dir/gateway.log" || true)"
    echo "fatal:    $(grep -cF '] FATAL (' "$dir/gateway.log" || true)"
    if [[ -f $dir/verdict.txt ]]; then cat "$dir/verdict.txt"; fi
  } | tee "$dir/summary.txt"
}
started=$(date +%s)
outages=0
trap cleanup EXIT
trap 'exit 130' INT TERM

start_broker
start_devices
sleep 3
node --max-semi-space-size=4 --env-file-if-exists="$env_file" "$repo/apps/gateway/src/main.ts" "$config" >"$dir/gateway.log" 2>&1 &
gateway=$!
log "soak started for $seconds s at speed $speed with $copies copy(ies) of every device in $dir (gateway $gateway, broker $broker, devices $devices)"
log "outage every $outage_every s for $outage_for s, sample every $sample_every s, the last $drain s without outages"
echo "time,rss_kb,cpu,open_files,buffer_bytes" >"$dir/samples.csv"

started=$(date +%s)
end=$((started + seconds))
next_sample=$started
next_outage=$((started + outage_every))
status=0
while (($(date +%s) < end)); do
  if ! kill -0 "$gateway" 2>/dev/null; then
    log "gateway exited"
    exit 1
  fi
  now=$(date +%s)
  if ((now >= next_sample)); then
    sample
    next_sample=$((now + sample_every))
  fi
  with_devices=$(((outages + 1) % 2 == 0))
  with_disk=$((${SOAK_DISK_FAULT:-0} == 1 && (outages + 1) % 3 == 0))
  if ((now >= next_outage && now + outage_for * (1 + with_disk) + drain <= end)); then
    outages=$((outages + 1))
    log "outage $outages start (devices: $with_devices, disk full: $with_disk)"
    if ((with_disk)); then dd if=/dev/zero of="$buffer_dir/fill" bs=1048576 2>/dev/null || true; fi
    stop_pid "$broker"
    if ((with_devices)); then stop_pid "$devices"; fi
    sleep "$outage_for"
    start_broker
    if ((with_devices)); then start_devices; fi
    log "outage $outages end (broker $broker, devices $devices)"
    if ((with_disk)); then
      sleep "$outage_for"
      rm -f "$buffer_dir/fill"
      log "disk freed"
    fi
    next_outage=$(($(date +%s) + outage_every))
  fi
  sleep 1
done
sample
log "soak done"
# The health message is read from the broker log, so the broker stays up until the check is done.
stop_pid "$gateway" INT
gateway=""
check "$(buffer_rows)" || status=1
exit $status
