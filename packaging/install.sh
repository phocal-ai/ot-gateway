#!/usr/bin/env bash
# Install (or upgrade) the gateway as a systemd service from this checkout.
#
#   sudo packaging/install.sh [path/to/gateway.json]
#
# - Copies the runtime files to /opt/plenum and installs their production
#   dependencies there (pnpm through corepack; Node 22.18 or later needed).
# - Creates the system user `plenum`, and /etc/plenum/gateway.json from the
#   config given (or keeps the one already there; the example config on a
#   first install). The outbox goes to /var/lib/plenum/buffer.sqlite.
# - Copies the built status page (apps/web/out) when there is one.
# - Validates the config with `main.ts --check` before touching the running
#   service, then installs packaging/systemd/plenum-gateway.service and
#   (re)starts it. Running it again upgrades in place.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
config_source=${1:-}
prefix=/opt/plenum

fail() {
  echo "install: $*" >&2
  exit 1
}

[[ $(id -u) == 0 ]] || fail "run as root (sudo)"
command -v systemctl >/dev/null || fail "systemd is needed"
command -v runuser >/dev/null || fail "runuser (util-linux) is needed"
command -v node >/dev/null || fail "Node.js 22.18 or later is needed: https://nodejs.org/en/download"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)' ||
  fail "Node.js $(node --version) is too old: 22.18 or later runs the TypeScript sources directly"

id plenum >/dev/null 2>&1 || useradd --system --home-dir /var/lib/plenum --shell /usr/sbin/nologin plenum

# Root copies the checkout: a symlink in it (say apps/web/out/env -> /etc/plenum/gateway.env) would end up
# where the service reads or serves files. node_modules is pnpm's own links, and is not copied.
links=$(cd "$repo" && find package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/gateway apps/web/out \
  -name node_modules -prune -o -type l -print 2>/dev/null | head -5)
[[ -z $links ]] || fail "the checkout has symlinks where only files belong, nothing was installed:"$'\n'"$links"

echo "Installing the gateway to $prefix"
mkdir -p "$prefix"
for path in package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/gateway; do
  mkdir -p "$prefix/$(dirname "$path")"
  rm -rf "${prefix:?}/$path"
  cp -R "$repo/$path" "$prefix/$path"
done
find "$prefix" -name node_modules -prune -exec rm -rf {} +
# The status page, when it is built (pnpm --filter @plenum/web build, on any machine: it is static files).
rm -rf "$prefix/apps/web"
if [[ -f $repo/apps/web/out/index.html ]]; then
  mkdir -p "$prefix/apps/web"
  cp -R "$repo/apps/web/out" "$prefix/apps/web/out"
else
  echo "The status page is not built (pnpm --filter @plenum/web build); the gateway serves its API only."
fi
(cd "$prefix" && corepack pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@plenum/gateway...")

mkdir -p /etc/plenum
if [[ -n $config_source ]]; then
  cp "$config_source" /etc/plenum/gateway.json.new
elif [[ ! -f /etc/plenum/gateway.json ]]; then
  cp "$repo/examples/gateway.json" /etc/plenum/gateway.json.new
fi
if [[ -f /etc/plenum/gateway.json.new ]]; then
  # The outbox lives in the service's state directory.
  node -e '
    const fs = require("fs")
    const path = "/etc/plenum/gateway.json.new"
    const config = JSON.parse(fs.readFileSync(path, "utf8"))
    if (config.buffer !== undefined) config.buffer.path = "/var/lib/plenum/buffer.sqlite"
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
  '
  # As the service user: checking loads the gateway's dependencies, and root has no business running them.
  (cd "$prefix" && runuser -u plenum -- node apps/gateway/src/main.ts --check /etc/plenum/gateway.json.new) ||
    { rm -f /etc/plenum/gateway.json.new; fail "the config is not valid; nothing was changed"; }
  mv /etc/plenum/gateway.json.new /etc/plenum/gateway.json
else
  (cd "$prefix" && runuser -u plenum -- node apps/gateway/src/main.ts --check /etc/plenum/gateway.json) ||
    fail "/etc/plenum/gateway.json is not valid"
fi
touch /etc/plenum/gateway.env
chmod 640 /etc/plenum/gateway.env
chgrp plenum /etc/plenum/gateway.env

cp "$repo/packaging/systemd/plenum-gateway.service" /etc/systemd/system/plenum-gateway.service
systemctl daemon-reload
systemctl enable plenum-gateway >/dev/null
systemctl restart plenum-gateway
sleep 2
systemctl --no-pager --lines=5 status plenum-gateway || true
echo
echo "Installed. Logs: journalctl -u plenum-gateway -f"
echo "Config: /etc/plenum/gateway.json; secrets and OTEL_* variables: /etc/plenum/gateway.env"
