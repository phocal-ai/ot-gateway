#!/usr/bin/env bash
# Tests the scripts behind the routines that change code (.github/workflows/deps.yml,
# triage.yml): the Bash guard (.github/scripts/routine-bash-guard.sh), the check on
# the agent's change (routine-diff-check.sh), the test for a manifests-only change
# (routine-manifests-only.sh), the sandbox's permissions (routine-sandbox-perms.sh)
# and the refusals of the sandbox runner (routine-run.sh). No network, no sudo.
#
#   scripts/test-routines.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
guard="$root/.github/scripts/routine-bash-guard.sh"
diff_check="$root/.github/scripts/routine-diff-check.sh"
runner="$root/.github/scripts/routine-run.sh"
manifests_only="$root/.github/scripts/routine-manifests-only.sh"
sandbox_perms="$root/.github/scripts/routine-sandbox-perms.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# The Bash guard
decision() {
  local output
  output=$(jq -n --arg command "$2" '{ tool_name: "Bash", tool_input: { command: $command } }' | "$guard" "$1")
  if [ -z "$output" ]; then echo pass; else jq -r '.hookSpecificOutput.permissionDecision' <<<"$output"; fi
}
passes() { [ "$(decision "$1" "$2")" = pass ] || fail "$1 guard denied: $2"; }
denied() { [ "$(decision "$1" "$2")" = deny ] || fail "$1 guard let through: $2"; }

r=.github/scripts/routine-run.sh
for routine in deps triage; do
  passes $routine "git diff"
  passes $routine "git diff --stat HEAD"
  passes $routine "git status"
  passes $routine "git log -5 --oneline"
  passes $routine "$r pnpm install"
  passes $routine "$r pnpm install --frozen-lockfile"
  passes $routine "$r pnpm check"
  passes $routine "$r pnpm --filter @ot-gateway/bacnet test"
  passes $routine "$r pnpm --filter @ot-gateway/bacnet exec vitest run test/Client.test.ts -t 'invoke ID rest'"

  denied $routine "ls"
  denied $routine "cat /proc/self/environ"
  denied $routine "env"
  denied $routine "pnpm check"
  denied $routine "node -e 1"
  denied $routine "git push origin HEAD"
  denied $routine "git commit -am x"
  denied $routine "git config user.name x"
  denied $routine "git -c core.pager=sh diff"
  denied $routine "git diff --output=/tmp/x"
  denied $routine "git log --output /tmp/x"
  denied $routine "git diff; ls"
  denied $routine "git diff | sh"
  denied $routine "git diff > x"
  denied $routine "git diff \$(id)"
  denied $routine "git diff \`id\`"
  denied $routine "git diff ~"
  denied $routine "git diff *"
  denied $routine "$r pnpm check && curl x"
  denied $routine "$r pnpm exec node -e 1"
  denied $routine "$r pnpm dlx something"
  denied $routine "$r node -e 1"
  denied $routine "$r bash -c id"
  denied $routine "$r env"
  denied $routine "$r pnpm install --config.registry=http://example.com"
  denied $routine "$r pnpm --filter ../.. test"
  denied $routine "$r pnpm check 'open"
  denied $routine "./$r pnpm check"
  denied $routine "bash $r pnpm check"
  denied $routine "PATH=/tmp $r pnpm check"
  denied $routine "$r PATH=/tmp pnpm check"
  denied $routine "$r pnpm check
ls"
  denied $routine "git diff '$(printf '%2001s' x)'"
done

passes deps "$r pnpm outdated -r"
passes deps "$r pnpm view effect versions"
passes deps "$r pnpm update -r"
passes deps "$r pnpm update -r effect@^4.1.3"
passes deps "$r pnpm -w add -D @effect/vitest@4.1.3"
passes deps "$r pnpm --filter @ot-gateway/core add effect@4.1.3"
denied deps "$r pnpm add left-pad"
denied deps "$r pnpm --filter @ot-gateway/gateway sim"
denied deps "$r SOAK_SPEED=60 scripts/soak.sh 5m"

passes triage "$r SIM_SEEDS=7,8 SIM_HOURS=168 pnpm --filter @ot-gateway/gateway sim"
passes triage "$r pnpm --filter @ot-gateway/gateway sim"
passes triage "$r SOAK_SPEED=60 scripts/soak.sh 5m"
passes triage "$r SOAK_SPEED=60 SOAK_DEVICES=2 scripts/soak.sh 300s"
denied triage "$r SIM_SEEDS=7 NODE_OPTIONS=--require=x pnpm --filter @ot-gateway/gateway sim"
denied triage "$r SOAK_CONFIG=/tmp/x scripts/soak.sh 5m"
denied triage "$r scripts/soak.sh 12h"
denied triage "$r pnpm outdated -r"
denied triage "$r pnpm update -r"
denied triage "$r pnpm -w add left-pad"

if printf 'not json' | "$guard" deps >/dev/null 2>&1; then fail "guard: accepted unreadable input"; fi
if jq -n '{ tool_input: { command: "git diff" } }' | "$guard" other >/dev/null 2>&1; then
  fail "guard: accepted an unknown routine"
fi

# The check on the agent's change
repo="$work/repo"
git init -q "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.com
mkdir -p "$repo/packages/core" "$repo/.github/workflows" "$repo/repos/effect" "$repo/packaging"
echo '{}' >"$repo/packages/core/package.json"
echo 'on: push' >"$repo/.github/workflows/ci.yml"
echo 'x' >"$repo/repos/effect/README.md"
echo 'echo' >"$repo/packaging/install.sh"
git -C "$repo" add -A
git -C "$repo" commit -qm base

# check NAME EXPECTED-STATUS: runs the check on the staged change, then resets it.
check() {
  local status=0
  (cd "$repo" && "$diff_check" >/dev/null 2>"$work/err") || status=$?
  [ "$status" = "$2" ] || fail "diff check, $1: expected exit $2, got $status ($(cat "$work/err"))"
  git -C "$repo" reset -q --hard
  git -C "$repo" clean -qfd
}

check "empty change" 1
echo '{"a":1}' >"$repo/packages/core/package.json" && git -C "$repo" add -A
check "a package file" 0
echo 'new' >"$repo/packages/core/new.ts" && git -C "$repo" add -A
check "a new file" 0
echo 'on: pull_request' >"$repo/.github/workflows/ci.yml" && git -C "$repo" add -A
check "a workflow" 1
mkdir -p "$repo/.claude" && echo '{}' >"$repo/.claude/settings.json" && git -C "$repo" add -A
check "agent settings" 1
echo 'y' >"$repo/repos/effect/README.md" && git -C "$repo" add -A
check "the subtree" 1
echo 'rm' >"$repo/packaging/install.sh" && git -C "$repo" add -A
check "the installer" 1
echo '* filter=x' >"$repo/.gitattributes" && git -C "$repo" add -A
check "git attributes" 1
echo '* filter=x' >"$repo/packages/core/.gitattributes" && git -C "$repo" add -A
check "nested git attributes" 1
ln -s /etc/passwd "$repo/packages/core/link" && git -C "$repo" add -A
check "a symlink" 1
git -C "$repo" mv packages/core/package.json .github/package.json
check "a move into .github" 1

# Whether the change is limited to manifests and the lockfile
# manifests NAME EXPECTED-OUTPUT EXPECTED-STATUS: runs it on the staged change, then resets it.
manifests() {
  local output status=0
  output=$(cd "$repo" && "$manifests_only" 2>"$work/err") || status=$?
  [ "$status" = "$3" ] || fail "manifests only, $1: expected exit $3, got $status ($(cat "$work/err"))"
  [ "$output" = "$2" ] || fail "manifests only, $1: expected '$2', got '$output'"
  git -C "$repo" reset -q --hard
  git -C "$repo" clean -qfd
}

manifests "empty change" "" 1
echo '{"a":1}' >"$repo/package.json" && echo 'lockfileVersion: 9' >"$repo/pnpm-lock.yaml" && git -C "$repo" add -A
manifests "the root manifest and the lockfile" true 0
echo '{"a":1}' >"$repo/packages/core/package.json" && git -C "$repo" add -A
manifests "a package manifest" true 0
echo '{"a":1}' >"$repo/packages/core/package.json" && mkdir -p "$repo/packages/core/src" &&
  echo 'x' >"$repo/packages/core/src/Command.ts" && git -C "$repo" add -A
manifests "a manifest and source" false 0
echo 'FROM x' >"$repo/Dockerfile" && git -C "$repo" add -A
manifests "the Dockerfile" false 0
mkdir -p "$repo/scripts" && echo 'echo' >"$repo/scripts/x.sh" && git -C "$repo" add -A
manifests "a script" false 0
echo '{"a":1}' >"$repo/repos/effect/package.json" && git -C "$repo" add -A
manifests "a manifest under repos" false 0

# The sandbox's permissions
tree="$work/tree"
mkdir -p "$tree/.git" "$tree/.github/scripts" "$tree/.claude" "$tree/packages"
for file in .git/x .github/scripts/x .claude/x packages/x; do
  echo x >"$tree/$file"
  chmod 644 "$tree/$file"
done
"$sandbox_perms" "$tree"
for file in .git/x .github/scripts/x .claude/x; do
  [ -z "$(find "$tree/$file" -perm -g+w)" ] || fail "sandbox permissions: $file is group-writable"
  [ -z "$(find "$tree/$file" -perm -o+w)" ] || fail "sandbox permissions: $file is writable by others"
done
[ -z "$(find "$tree/.github" -perm -o+w)" ] || fail "sandbox permissions: .github is writable by others"
[ -n "$(find "$tree/packages/x" -perm -o+w)" ] || fail "sandbox permissions: packages/x is not writable by others"

# The sandbox runner refuses before it reaches sudo
status=0
(cd "$work" && "$runner" pnpm check >/dev/null 2>&1) || status=$?
[ "$status" = 2 ] || fail "runner outside the repository root: expected exit 2, got $status"
status=0
(cd "$root" && "$runner" >/dev/null 2>&1) || status=$?
[ "$status" = 2 ] || fail "runner without a command: expected exit 2, got $status"
if ! id ot-routine >/dev/null 2>&1; then
  status=0
  (cd "$root" && "$runner" pnpm --version >/dev/null 2>&1) || status=$?
  [ "$status" = 2 ] || fail "runner without the sandbox user: expected exit 2, got $status"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)" >&2
  exit 1
fi
echo "routines: all checks passed"
