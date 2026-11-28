#!/usr/bin/env bash
# Moves every release pin to a new tag, for the release's pin pull request into dev (CONTRIBUTING.md, "Branches"):
#
#   scripts/release-pins.sh v0.19.2
#
# The pins: the default tag in packaging/compose.yaml (OT_GATEWAY_TAG, the reference the Release tag workflow tags)
# and in packaging/ot-gateway (release=), the tag in docs/operations.md and docs/raspberry-pi-testing.md, and the
# Claude Code plugin: the exact npm version its MCP server runs (plugins/ot-gateway/.mcp.json, npx -y ot-gateway@X.Y.Z)
# and its version (plugins/ot-gateway/.claude-plugin/plugin.json), so `claude plugin update` moves to the release and
# npx never runs an older ot-gateway it has cached. apps/gateway/test/ReleasePins.test.ts fails when one is missed.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tag=${1:-}
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "usage: scripts/release-pins.sh vX.Y.Z (or vX.Y.Z-rc.N)" >&2
  exit 2
}
version=${tag#v}

old=$(sed -nE 's/.*OT_GATEWAY_TAG:-(v[^}]+)}.*/\1/p' "$repo/packaging/compose.yaml" | head -n 1)
[[ -n $old ]] || {
  echo "packaging/compose.yaml has no OT_GATEWAY_TAG:-vX.Y.Z default" >&2
  exit 1
}

cd "$repo"
export OLD=$old NEW=$tag VERSION=$version
# Every occurrence of the old tag, as the earlier releases moved them by hand.
perl -pi -e 's/\Q$ENV{OLD}\E(?![0-9A-Za-z.-]*[0-9A-Za-z])/$ENV{NEW}/g' \
  packaging/compose.yaml packaging/ot-gateway docs/operations.md docs/raspberry-pi-testing.md
perl -pi -e 's/"-y", "ot-gateway(?:@[^"]*)?"/"-y", "ot-gateway\@$ENV{VERSION}"/' plugins/ot-gateway/.mcp.json
perl -pi -e 's/"version": "[^"]*"/"version": "$ENV{VERSION}"/' plugins/ot-gateway/.claude-plugin/plugin.json

echo "Pins moved from ${old} to ${tag}:"
git --no-pager diff --stat -- packaging docs plugins 2>/dev/null || true
