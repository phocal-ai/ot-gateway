#!/usr/bin/env bash
# Install (or upgrade) the gateway as a systemd service from this checkout.
#
#   sudo packaging/install.sh [path/to/gateway.json]
#
# - Builds the runtime files and their production dependencies in
#   /opt/plenum.new (pnpm through corepack; Node 22.18 or later needed), and
#   swaps them in for /opt/plenum only once the config passes their check.
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

# The new version is built next to the running one and checked against the config before it replaces
# anything: a config the new version refuses leaves the running gateway, its files and its config as they were.
staging="$prefix.new"
rm -rf "$staging"
trap 'rm -rf "$staging" /etc/plenum/gateway.json.new' EXIT
echo "Building the gateway in $staging"
for path in package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/gateway; do
  mkdir -p "$staging/$(dirname "$path")"
  cp -R "$repo/$path" "$staging/$path"
done
find "$staging" -name node_modules -prune -exec rm -rf {} +
# Which build this is, for telemetry and the status page (the checkout may belong to another user, hence safe.directory).
git -c safe.directory="$repo" -C "$repo" describe --tags --always --dirty >"$staging/VERSION" 2>/dev/null ||
  echo dev >"$staging/VERSION"
# The status page, when it is built (pnpm --filter @plenum/web build, on any machine: it is static files).
if [[ -f $repo/apps/web/out/index.html ]]; then
  mkdir -p "$staging/apps/web"
  cp -R "$repo/apps/web/out" "$staging/apps/web/out"
else
  echo "The status page is not built (pnpm --filter @plenum/web build); the gateway serves its API only."
fi
(cd "$staging" && corepack pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@plenum/gateway...")

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
  (cd "$staging" && runuser -u plenum -- node apps/gateway/src/main.ts --check /etc/plenum/gateway.json.new) ||
    fail "the config is not valid; nothing was changed"
else
  (cd "$staging" && runuser -u plenum -- node apps/gateway/src/main.ts --check /etc/plenum/gateway.json) ||
    fail "/etc/plenum/gateway.json is not valid for this version; nothing was changed"
fi

# Checked: swap the new version in, then the new config.
if [[ -d $prefix ]]; then
  rm -rf "$prefix.old"
  mv "$prefix" "$prefix.old"
fi
mv "$staging" "$prefix"
rm -rf "$prefix.old"
[[ -f /etc/plenum/gateway.json.new ]] && mv /etc/plenum/gateway.json.new /etc/plenum/gateway.json
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
