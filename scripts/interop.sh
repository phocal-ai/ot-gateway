#!/usr/bin/env bash
# Interop tests: Plenum against implementations that are not ours, so a spec
# misread the same way in our client and our simulators cannot hide.
#
#   scripts/interop.sh                 # all peers
#   scripts/interop.sh mqtt modbus     # some of them
#
# - mqtt: Mosquitto 2 and EMQX 5 (Docker): the client, and the whole gateway
#   with commands, against each broker.
# - bacnet: the BACnet Stack demo server, bacserv (Docker, built from a pinned
#   release in test/interop/bacnet), on its own bridge network so its
#   broadcast I-Am reaches the test, which binds the BACnet port 47808.
# - modbus: a pymodbus server (Python 3, a pinned version in a virtualenv).
#
# Everything started is stopped on exit. The tests are in
# apps/gateway/test/interop and run only with PLENUM_INTEROP=1.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
work=${INTEROP_DIR:-${TMPDIR:-/tmp}/plenum-interop}
mkdir -p "$work"
peers=("$@")
[[ ${#peers[@]} -eq 0 ]] && peers=(mqtt bacnet modbus)
wants() { [[ " ${peers[*]} " == *" $1 "* ]]; }

containers=()
modbus_pid=""
cleanup() {
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  docker network rm plenum-interop >/dev/null 2>&1 || true
  if [[ -n $modbus_pid ]]; then kill "$modbus_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

wait_for_port() {
  local host=$1 port=$2
  for _ in $(seq 120); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "nothing listens on $host:$port" >&2
  return 1
}

export PLENUM_INTEROP=1

if wants mqtt; then
  docker run -d --name plenum-interop-mosquitto -p 127.0.0.1:18831:1883 \
    -v "$repo/test/interop/mqtt/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" eclipse-mosquitto:2.0.18 >/dev/null
  containers+=(plenum-interop-mosquitto)
  docker run -d --name plenum-interop-emqx -p 127.0.0.1:18832:1883 emqx/emqx:5.8.6 >/dev/null
  containers+=(plenum-interop-emqx)
  wait_for_port 127.0.0.1 18831
  # EMQX accepts TCP before it takes MQTT connections.
  for _ in $(seq 120); do docker logs plenum-interop-emqx 2>&1 | grep -q "is running now" && break; sleep 1; done
  export PLENUM_INTEROP_BROKERS=mqtt://127.0.0.1:18831,mqtt://127.0.0.1:18832
fi

if wants bacnet; then
  docker build -q -t plenum-interop-bacserv "$repo/test/interop/bacnet" >/dev/null
  docker network create --subnet 172.30.0.0/24 plenum-interop >/dev/null
  docker run -d --name plenum-interop-bacserv --network plenum-interop --ip 172.30.0.10 plenum-interop-bacserv 2002 >/dev/null
  containers+=(plenum-interop-bacserv)
  export PLENUM_INTEROP_BACNET=172.30.0.10 PLENUM_INTEROP_BACNET_BROADCAST=172.30.0.255
fi

if wants modbus; then
  [[ -x $work/venv/bin/python ]] || python3 -m venv "$work/venv"
  "$work/venv/bin/pip" install -q -r "$repo/test/interop/modbus/requirements.txt"
  "$work/venv/bin/python" "$repo/test/interop/modbus/server.py" 15020 >"$work/modbus.log" 2>&1 &
  modbus_pid=$!
  wait_for_port 127.0.0.1 15020
  export PLENUM_INTEROP_MODBUS=127.0.0.1:15020
fi

cd "$repo/apps/gateway"
pnpm exec vitest run test/interop
