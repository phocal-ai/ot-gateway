#!/usr/bin/env bash
# Soak test: the gateway against the bench for hours, with faults injected.
#
#   scripts/soak.sh [hours]        # default 24; SOAK_SECONDS overrides it
#
# - Runs the MQTT test broker, the simulated devices and the gateway as three
#   processes started from examples/gateway.json, with change of value turned
#   on for every BACnet device.
# - Every OUTAGE_EVERY seconds (default 2 h) the broker stops for OUTAGE_FOR
#   seconds (default 60), so the buffer fills and drains. Every second outage
#   also stops the devices, so reads fail, recover and COV resubscribes.
# - SOAK_DISK_FAULT=1 (macOS only) puts the buffer on a 16 MB disk image and
#   fills the disk during every third outage.
# - Every SAMPLE_EVERY seconds (default 10 min) it records memory, CPU, open
#   files and the buffer size of the gateway in samples.csv.
#
# Processes are tracked by PID and only those are stopped. Results go to
# SOAK_DIR (default $TMPDIR/plenum-soak-<time>). The gateway loads the same env
# file as `pnpm gateway`, so its telemetry reaches the configured backend.
set -euo pipefail

hours=${1:-24}
repo=$(cd "$(dirname "$0")/.." && pwd)
dir=${SOAK_DIR:-${TMPDIR:-/tmp}/plenum-soak-$(date +%Y%m%dT%H%M%S)}
outage_every=${OUTAGE_EVERY:-7200}
outage_for=${OUTAGE_FOR:-60}
sample_every=${SAMPLE_EVERY:-600}
env_file=${PLENUM_ENV_FILE:-$HOME/.config/phocal/plenum-gateway.env}
mkdir -p "$dir"
log() { echo "$(date +%FT%T) $*" | tee -a "$dir/events.log"; }

buffer_dir=$dir
volume=""
if [[ ${SOAK_DISK_FAULT:-0} == 1 ]]; then
  if [[ $(uname) != Darwin ]]; then
    echo "SOAK_DISK_FAULT needs macOS (hdiutil); run without it" >&2
    exit 1
  fi
  hdiutil create -quiet -size 16m -fs HFS+ -volname plenum-soak "$dir/disk.dmg"
  volume=$(hdiutil attach -nobrowse "$dir/disk.dmg" | awk -F'\t' '/plenum-soak/ {print $NF}')
  buffer_dir=$volume
fi

config=$dir/gateway.json
node -e '
  const [source, target, buffer] = process.argv.slice(1)
  const config = JSON.parse(require("fs").readFileSync(source, "utf8"))
  config.buffer = { ...config.buffer, path: buffer }
  for (const device of config.devices) if (device.protocol === "bacnet-ip") device.cov = true
  require("fs").writeFileSync(target, JSON.stringify(config, null, 2))
' "$repo/examples/gateway.json" "$config" "$buffer_dir/buffer.sqlite"

broker=""
devices=""
gateway=""
start_broker() {
  node "$repo/apps/gateway/src/bench.ts" --only broker "$config" >>"$dir/broker.log" 2>&1 &
  broker=$!
}
start_devices() {
  node "$repo/apps/gateway/src/bench.ts" --only devices "$config" >>"$dir/devices.log" 2>&1 &
  devices=$!
}
stop_pid() {
  local pid=$1 signal=${2:-TERM}
  [[ -z $pid ]] && return
  kill "-$signal" "$pid" 2>/dev/null || return 0
  for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null || true
}
cleanup() {
  stop_pid "$gateway" INT
  stop_pid "$devices"
  stop_pid "$broker"
  rm -f "$buffer_dir/fill"
  [[ -n $volume ]] && hdiutil detach -quiet "$volume" || true
  log "soak stopped"
  summary
}
summary() {
  {
    echo "warnings: $(grep -cF '] WARN (' "$dir/gateway.log" || true)"
    echo "errors:   $(grep -cF '] ERROR (' "$dir/gateway.log" || true)"
    echo "fatal:    $(grep -cF '] FATAL (' "$dir/gateway.log" || true)"
    awk -F, 'NR > 1 && $2 != "" { if (min == "" || $2 < min) min = $2; if ($2 > max) max = $2 }
      END { printf "rss kB:   %s to %s\n", min, max }' "$dir/samples.csv"
  } | tee "$dir/summary.txt"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

start_broker
start_devices
sleep 3
node --env-file-if-exists="$env_file" "$repo/apps/gateway/src/main.ts" "$config" >"$dir/gateway.log" 2>&1 &
gateway=$!
log "soak started for $hours h in $dir (gateway $gateway, broker $broker, devices $devices)"
echo "time,rss_kb,cpu,open_files,buffer_bytes" >"$dir/samples.csv"

started=$(date +%s)
end=$((started + ${SOAK_SECONDS:-$((hours * 3600))}))
next_sample=$started
next_outage=$((started + outage_every))
outages=0
while (($(date +%s) < end)); do
  if ! kill -0 "$gateway" 2>/dev/null; then
    log "gateway exited"
    exit 1
  fi
  now=$(date +%s)
  if ((now >= next_sample)); then
    rss=$(ps -o rss= -p "$gateway" | tr -d ' ')
    cpu=$(ps -o %cpu= -p "$gateway" | tr -d ' ')
    files=$( (lsof -p "$gateway" 2>/dev/null || true) | wc -l | tr -d ' ')
    bytes=$( (cat "$buffer_dir"/buffer.sqlite* 2>/dev/null || true) | wc -c | tr -d ' ')
    echo "$(date +%FT%T),$rss,$cpu,$files,$bytes" >>"$dir/samples.csv"
    next_sample=$((now + sample_every))
  fi
  if ((now >= next_outage)); then
    outages=$((outages + 1))
    with_devices=$((outages % 2 == 0))
    with_disk=$((${SOAK_DISK_FAULT:-0} == 1 && outages % 3 == 0))
    log "outage $outages start (devices: $with_devices, disk full: $with_disk)"
    if ((with_disk)); then dd if=/dev/zero of="$buffer_dir/fill" bs=1m 2>/dev/null || true; fi
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
  sleep 5
done
log "soak done"
