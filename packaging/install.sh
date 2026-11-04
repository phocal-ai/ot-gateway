#!/usr/bin/env bash
# Install (or upgrade) the gateway as a systemd service from this checkout.
#
#   sudo packaging/install.sh [path/to/gateway.json]
#
# - Builds the runtime files and their production dependencies in
#   /opt/ot-gateway.new (pnpm through corepack; Node 22.18 or later needed), and
#   swaps them in for /opt/ot-gateway only once the config passes their check.
# - Creates the system user `ot-gateway`, and /etc/ot-gateway/gateway.json from the
#   config given (or keeps the one already there; the example config on a
#   first install). The outbox goes to /var/lib/ot-gateway/buffer.sqlite.
# - Copies the built status page (apps/web/out) when there is one.
# - Validates the config with `main.ts --check` before touching the running
#   service, then installs packaging/systemd/ot-gateway.service and
#   (re)starts it. Running it again upgrades in place.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
config_source=${1:-}
prefix=/opt/ot-gateway

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

id ot-gateway >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ot-gateway --shell /usr/sbin/nologin ot-gateway

# Root copies the checkout: a symlink in it (say apps/web/out/env -> /etc/ot-gateway/gateway.env) would end up
# where the service reads or serves files. node_modules is pnpm's own links, and is not copied.
links=$(cd "$repo" && find package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/gateway apps/web/out \
  -name node_modules -prune -o -type l -print 2>/dev/null | head -5)
[[ -z $links ]] || fail "the checkout has symlinks where only files belong, nothing was installed:"$'\n'"$links"

# The new version is built next to the running one and checked against the config before it replaces
# anything: a config the new version refuses leaves the running gateway, its files and its config as they were.
staging="$prefix.new"
rm -rf "$staging"
trap 'rm -rf "$staging" /etc/ot-gateway/gateway.json.new' EXIT
echo "Building the gateway in $staging"
for path in package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/gateway; do
  mkdir -p "$staging/$(dirname "$path")"
  cp -R "$repo/$path" "$staging/$path"
done
find "$staging" -name node_modules -prune -exec rm -rf {} +
# Which build this is, for telemetry and the status page (the checkout may belong to another user, hence safe.directory).
git -c safe.directory="$repo" -C "$repo" describe --tags --always --dirty >"$staging/VERSION" 2>/dev/null ||
  echo dev >"$staging/VERSION"
# The status page, when it is built (pnpm --filter @ot-gateway/web build, on any machine: it is static files).
if [[ -f $repo/apps/web/out/index.html ]]; then
  mkdir -p "$staging/apps/web"
  cp -R "$repo/apps/web/out" "$staging/apps/web/out"
else
  echo "The status page is not built (pnpm --filter @ot-gateway/web build); the gateway serves its API only."
fi
(cd "$staging" && corepack pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@ot-gateway/gateway...")

mkdir -p /etc/ot-gateway
if [[ -n $config_source ]]; then
  cp "$config_source" /etc/ot-gateway/gateway.json.new
elif [[ ! -f /etc/ot-gateway/gateway.json ]]; then
  cp "$repo/examples/gateway.json" /etc/ot-gateway/gateway.json.new
fi
if [[ -f /etc/ot-gateway/gateway.json.new ]]; then
  # The outbox lives in the service's state directory.
  node -e '
    const fs = require("fs")
    const path = "/etc/ot-gateway/gateway.json.new"
    const config = JSON.parse(fs.readFileSync(path, "utf8"))
    if (config.buffer !== undefined) config.buffer.path = "/var/lib/ot-gateway/buffer.sqlite"
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
  '
  # As the service user: checking loads the gateway's dependencies, and root has no business running them.
  (cd "$staging" && runuser -u ot-gateway -- node apps/gateway/src/main.ts --check /etc/ot-gateway/gateway.json.new) ||
    fail "the config is not valid; nothing was changed"
else
  (cd "$staging" && runuser -u ot-gateway -- node apps/gateway/src/main.ts --check /etc/ot-gateway/gateway.json) ||
    fail "/etc/ot-gateway/gateway.json is not valid for this version; nothing was changed"
fi

# Checked: swap the new version in, then the new config.
if [[ -d $prefix ]]; then
  rm -rf "$prefix.old"
  mv "$prefix" "$prefix.old"
fi
mv "$staging" "$prefix"
rm -rf "$prefix.old"
[[ -f /etc/ot-gateway/gateway.json.new ]] && mv /etc/ot-gateway/gateway.json.new /etc/ot-gateway/gateway.json
touch /etc/ot-gateway/gateway.env
chmod 640 /etc/ot-gateway/gateway.env
chgrp ot-gateway /etc/ot-gateway/gateway.env

cp "$repo/packaging/systemd/ot-gateway.service" /etc/systemd/system/ot-gateway.service
systemctl daemon-reload
systemctl enable ot-gateway >/dev/null
systemctl restart ot-gateway
sleep 2
systemctl --no-pager --lines=5 status ot-gateway || true
echo
echo "Installed. Logs: journalctl -u ot-gateway -f"
echo "Config: /etc/ot-gateway/gateway.json; secrets and OTEL_* variables: /etc/ot-gateway/gateway.env"
