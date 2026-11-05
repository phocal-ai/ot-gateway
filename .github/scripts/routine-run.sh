#!/usr/bin/env bash
# Runs a command from the checkout as the routines' sandbox user, for the weekly
# dependency update and the CI failure triage (.github/workflows/deps.yml, triage.yml).
#
#   .github/scripts/routine-run.sh [NAME=VALUE ...] COMMAND [ARGS ...]
#
# Tests, builds and package scripts run code the agent may have edited and code from
# npm, so they run as `ot-routine` with an empty environment:
# - It is not the runner user, so it cannot read the agent's environment
#   (/proc/<pid>/environ is private to its owner), which holds the Claude token.
# - It has no sudo, no GitHub token and no git credentials.
# - It cannot write .git, so it cannot change history or git config.
# The workflow's Sandbox step creates the user and installs pnpm for it. Only the
# listed variables and the NAME=VALUE words before the command reach it.
# routine-bash-guard.sh decides which commands may get here.
set -euo pipefail

readonly user=ot-routine

[ $# -ge 1 ] || {
  echo "routine-run: usage: routine-run.sh [NAME=VALUE ...] COMMAND [ARGS ...]" >&2
  exit 2
}
[ -f pnpm-workspace.yaml ] || {
  echo "routine-run: run it from the repository root" >&2
  exit 2
}
id "$user" >/dev/null 2>&1 || {
  echo "routine-run: the sandbox user $user does not exist; the workflow's Sandbox step creates it" >&2
  exit 2
}

workspace=$(pwd)
home=$(getent passwd "$user" | cut -d: -f6)
node_dir=$(dirname "$(command -v node)")

# umask 000: files it creates stay writable for the agent, which runs as another user.
exec sudo -n -u "$user" -- env -i \
  HOME="$home" \
  PATH="$home/.local/bin:$node_dir:/usr/local/bin:/usr/bin:/bin" \
  LANG=C.UTF-8 TZ=UTC CI=1 \
  NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$workspace" \
  bash -c 'umask 000; cd "$1" && shift && exec env "$@"' routine-run "$workspace" "$@"
