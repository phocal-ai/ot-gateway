#!/usr/bin/env bash
# Tests .github/scripts/health-gh.sh, the Health agent's GitHub CLI, against a stub
# `gh` on PATH. No network: the stub answers from fixtures and logs its arguments.
#
#   scripts/test-health-gh.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
wrapper="$root/.github/scripts/health-gh.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/runner-temp"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh: logs the call, answers `issue view` and `issue list` from fixtures.
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_LOG"
bot_issue='"author":{"login":"app/github-actions","is_bot":true},"title":"Logs at 80%","body":"<!-- health:budget:logs -->\nbot body"'
user_issue='"author":{"login":"someone"},"title":"user title","body":"user body"'
comments='"comments":[{"author":{"login":"github-actions"},"createdAt":"2026-11-01T06:20:00Z","body":"bot comment"},{"author":{"login":"someone"},"createdAt":"2026-11-02T06:20:00Z","body":"user comment"}]'
case "$1 $2 ${3:-}" in
  "issue view 7") echo "{\"number\":7,\"state\":\"OPEN\",$bot_issue,\"labels\":[{\"name\":\"health\"}],$comments}" ;;
  "issue view 8") echo "{\"number\":8,\"state\":\"OPEN\",$bot_issue,\"labels\":[{\"name\":\"bug\"}],$comments}" ;;
  "issue view 9") echo "{\"number\":9,\"state\":\"OPEN\",$user_issue,\"labels\":[{\"name\":\"health\"}],$comments}" ;;
  "issue view "*) echo "GraphQL: Could not resolve to an issue" >&2; exit 1 ;;
  "issue list "*) echo "[{\"number\":7,$bot_issue},{\"number\":9,$user_issue}]" ;;
  *) echo "stub: ok" ;;
esac
STUB
chmod +x "$work/bin/gh"

export PATH="$work/bin:$PATH" STUB_LOG="$work/gh.log" RUNNER_TEMP="$work/runner-temp"
export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat-test-0123456789" GRAFANA_MCP_READ_TOKEN="glsa_test_0123456789"
export GRAFANA_MCP_URL="https://example-stack.grafana.net/" GH_TOKEN="ghs_test0123456789"

failures=0
marker=$'<!-- health:budget:logs -->\nEvidence'

fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# run ARGS...: runs the wrapper with a fresh log; sets $status, $out and $err.
run() {
  : >"$STUB_LOG"
  status=0
  "$wrapper" "$@" >"$work/out" 2>"$work/err" || status=$?
  out=$(cat "$work/out")
  err=$(cat "$work/err")
}

# ok NAME ARGS...: the wrapper succeeds.
ok() {
  local name=$1
  shift
  run "$@"
  [ "$status" = 0 ] || fail "$name: exit $status, $err"
}

# refused NAME ARGS...: the wrapper exits 2 without writing anything.
refused() {
  local name=$1
  shift
  run "$@"
  [ "$status" = 2 ] || fail "$name: expected exit 2, got $status"
  [[ $err == health-gh:* ]] || fail "$name: no refusal message"
  ! grep -qE '^(issue (create|comment|close)|label create)' "$STUB_LOG" || fail "$name: reached gh with a write"
}

logged() { grep -qF -- "$1" "$STUB_LOG"; }

# Commands outside the list
refused "no arguments"
refused "pr list" pr list
refused "api" api repos/x/y
refused "issue edit" issue edit 7 --title x
refused "issue delete" issue delete 7
refused "label delete" label delete health
refused "repo view" repo view
[ ! -s "$STUB_LOG" ] || fail "unknown commands reached gh"

# issue list
ok "list" issue list --state open --json number,title,body --limit 100
logged "issue list --label health --state open --limit 100 --json number,title,body,author" || fail "list: forced label and fields"
[ "$(jq -c 'map(.number)' <<<"$out")" = "[7]" ] || fail "list: shows only bot issues, got $out"
[[ $out != *author* ]] || fail "list: author left in the output"
ok "list --label=health" issue list --label=health
refused "list other label" issue list --label bug
refused "list search" issue list --search "is:open"
refused "list comments field" issue list --json number,comments
refused "list jq" issue list --json number --jq '.[]'
refused "list bad state" issue list --state merged

# issue view
ok "view" issue view 7
[ "$(jq -r '.body' <<<"$out")" = $'<!-- health:budget:logs -->\nbot body' ] || fail "view: body"
[ "$(jq -c '[.comments[].body]' <<<"$out")" = '["bot comment"]' ] || fail "view: only bot comments, got $out"
ok "view user issue" issue view 9
[[ $out != *"user body"* && $out != *"user title"* ]] || fail "view: shows a body or title not by the bot"
refused "view unlabelled" issue view 8
[[ $out != *"bot body"* ]] || fail "view unlabelled: printed the issue"
refused "view not a number" issue view 7abc
refused "view extra flag" issue view 7 --comments
refused "view other repo" issue view 7 --repo other/repo

# issue create
ok "create" issue create --title "Logs at 80%" --body "$marker"
logged "issue create --title Logs at 80% --body <!-- health:budget:logs -->" || fail "create: call"
logged "Evidence --label health" || fail "create: forced label"
refused "create without marker" issue create --title t --body "no marker"
refused "create marker not first" issue create --title t --body $'intro\n<!-- health:x -->'
refused "create body-file" issue create --title t --body-file body.md
refused "create assignee" issue create --title t --body "$marker" --assignee someone
refused "create project" issue create --title t --body "$marker" --project Board
refused "create other label" issue create --title t --body "$marker" --label bug
refused "create no title" issue create --body "$marker"
refused "create token in body" issue create --title t --body "$marker $GH_TOKEN"
[[ $err != *"$GH_TOKEN"* ]] || fail "create token in body: printed the value"
refused "create oauth token in title" issue create --title "x$CLAUDE_CODE_OAUTH_TOKEN" --body "$marker"
refused "create grafana token" issue create --title t --body "$marker $GRAFANA_MCP_READ_TOKEN"
refused "create grafana url" issue create --title t --body "$marker see https://example-stack.grafana.net/explore"
refused "create grafana host" issue create --title t --body "$marker on example-stack.grafana.net"

# At most 5 creations per run, counting the one above
for n in 2 3 4 5; do ok "create $n" issue create --title "t$n" --body "$marker"; done
refused "create 6" issue create --title t6 --body "$marker"
rm -rf "$RUNNER_TEMP/health-gh-creates"

# issue comment
ok "comment" issue comment 7 --body "Today: 41 GB"
logged "issue comment 7 --body Today: 41 GB" || fail "comment: call"
ok "comment --body=" issue comment 7 --body="Today: 42 GB"
refused "comment unlabelled" issue comment 8 --body "x"
run issue comment 12345 --body "x"
if [ "$status" = 0 ] || logged "issue comment"; then fail "comment unknown issue: expected a failure before writing"; fi
refused "comment body-file" issue comment 7 --body-file x.md
refused "comment edit-last" issue comment 7 --body x --edit-last
refused "comment no body" issue comment 7
refused "comment token" issue comment 7 --body "token $GH_TOKEN"
refused "comment not a number" issue comment "7;x" --body x

# issue close
ok "close" issue close 7
logged "issue close 7" || fail "close: call"
ok "close with comment" issue close 7 --comment "Back to 30%"
logged "issue close 7 --comment Back to 30%" || fail "close with comment: call"
refused "close unlabelled" issue close 8
refused "close reason" issue close 7 --reason "not planned"
refused "close token" issue close 7 --comment "$GRAFANA_MCP_READ_TOKEN"

# label create
ok "label" label create health --color D93F0B --description "Found by the scheduled health check"
logged "label create health --color D93F0B --description Found by the scheduled health check" || fail "label: call"
refused "label force" label create health --color D93F0B --force
refused "label other" label create bug
refused "label bad color" label create health --color red

if [ "$failures" -gt 0 ]; then
  echo "$failures health-gh check(s) failed" >&2
  exit 1
fi
echo "health-gh: all checks passed"
