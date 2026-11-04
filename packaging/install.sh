#!/usr/bin/env bash
# Install (or upgrade) the gateway as a systemd service from this checkout.
#
#   sudo packaging/install.sh [path/to/gateway.json]
#
# - Runs from a checkout owned by root or by the user running sudo, and not writable
#   by group or others; it refuses any other and installs nothing.
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

repo=$(cd "$(dirname "$0")/.." && pwd -P)
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

# Root copies the checkout: a symlink in it (say apps/web/out/env -> /etc/ot-gateway/gateway.env) would end up
# where the service reads or serves files. node_modules is pnpm's own links, and is not copied.
links=$(cd "$repo" && find package.json pnpm-lock.yaml pnpm-workspace.yaml packages apps/gateway apps/web/out \
  packaging examples -name node_modules -prune -o -type l -print 2>/dev/null | head -5)
[[ -z $links ]] || fail "the checkout has symlinks where only files belong, nothing was installed:"$'\n'"$links"

# Root installs what this checkout holds, so the checkout has to be under the control of root or of the user
# running sudo. check_control reads "uid mode path" lines (stat -c '%u %a %n') and fails on the first path that
# belongs to someone else or that group or others may write to. A parent directory others may write to passes
# when its sticky bit is set (/tmp, say): then only the owner of an entry in it can rename or remove that entry.
check_control() {
  local kind=$1 uid mode path others_write sticky who=root${SUDO_USER:+ or $SUDO_USER}
  while read -r uid mode path; do
    [[ -n $path ]] || continue
    if [[ $uid != 0 && $uid != "${SUDO_UID:-0}" ]]; then
      if [[ $kind == parent ]]; then
        fail "$path belongs to uid $uid, not $who; move the checkout under a directory you own, nothing was installed"
      fi
      fail "$path belongs to uid $uid, not $who; nothing was installed." \
        "Run install.sh with sudo from the account that owns the checkout, or fix it with: sudo chown -R ${SUDO_USER:-root} $repo"
    fi
    others_write=$((8#$mode & 8#022)) sticky=$((8#$mode & 8#1000))
    if ((others_write)) && ! [[ $kind == parent && $sticky != 0 ]]; then
      fail "$path is writable by group or others; nothing was installed. Fix it with: chmod go-w $path"
    fi
  done
}

parents=()
dir=$repo
while [[ $dir != / ]]; do
  dir=$(dirname "$dir")
  parents+=("$dir")
done
parent_modes=$(stat -c '%u %a %n' -- "${parents[@]}") || fail "cannot read the owners of the directories above $repo"
check_control parent <<<"$parent_modes"
checkout_paths=("$repo" "$repo/package.json" "$repo/pnpm-lock.yaml" "$repo/pnpm-workspace.yaml")
# A source tree without git (an unpacked archive) installs too, as version "dev".
[[ -e $repo/.git ]] && checkout_paths+=("$repo/.git")
checkout_modes=$(
  stat -c '%u %a %n' -- "${checkout_paths[@]}" &&
    find "$repo/packaging" "$repo/examples" -exec stat -c '%u %a %n' -- {} +
) || fail "cannot read the owners of the files in $repo; is it a full checkout?"
check_control checkout <<<"$checkout_modes"

id ot-gateway >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ot-gateway --shell /usr/sbin/nologin ot-gateway

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
# Which build this is, for telemetry and the status page. git runs as the checkout's owner: it is their repository,
# so git reads its config and writes its index with their rights rather than root's.
owner_uid=$(stat -c %u "$repo")
as_checkout_owner() {
  if [[ $owner_uid == 0 ]]; then
    "$@"
  else
    runuser -u "$(id -nu "$owner_uid")" -- "$@"
  fi
}
as_checkout_owner git -C "$repo" describe --tags --always --dirty >"$staging/VERSION" 2>/dev/null ||
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
