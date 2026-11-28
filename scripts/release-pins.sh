#!/usr/bin/env bash
# Moves every release pin to a new tag, for the release's pin pull request into dev (CONTRIBUTING.md, "Branches"):
#
#   scripts/release-pins.sh v0.19.2
#
# The pins: the default tag in packaging/compose.yaml (OT_GATEWAY_TAG, the reference the Release tag workflow tags)
# and in packaging/ot-gateway (release=), the tag in docs/operations.md and docs/raspberry-pi-testing.md, and the
# Claude Code plugin: the exact npm version its MCP server runs (plugins/ot-gateway/.mcp.json, npx -y ot-gateway@X.Y.Z)
# and its version (plugins/ot-gateway/.claude-plugin/plugin.json), so `claude plugin update` moves to the release and
# npx never runs an older ot-gateway it has cached; a prerelease leaves the plugin alone. The marketplace reads dev, so
# the plugin names the release before npm has it: merge dev into main right after, and the plugin's server starts again
# as soon as the Package workflow publishes (npx fetches it on the next start). apps/gateway/test/ReleasePins.test.ts
# fails when one pin is missed.
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
docs=(packaging/compose.yaml packaging/ot-gateway docs/operations.md docs/raspberry-pi-testing.md)
plugin=(plugins/ot-gateway/.mcp.json plugins/ot-gateway/.claude-plugin/plugin.json)
export OLD=$old NEW=$tag VERSION=$version
# Every occurrence of the old tag, as the earlier releases moved them by hand.
perl -pi -e 's/\Q$ENV{OLD}\E(?![0-9A-Za-z.-]*[0-9A-Za-z])/$ENV{NEW}/g' "${docs[@]}"
for file in "${docs[@]}"; do
  grep -qF "$tag" "$file" || {
    echo "$file names no $tag after the move: move its pin by hand" >&2
    exit 1
  }
done

# A prerelease (v0.20.0-rc.1) stays off the plugin, as it stays off :latest and npm's latest: every plugin user who
# updates would run it.
if [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  perl -pi -e 's/"-y", "ot-gateway(?:@[^"]*)?"/"-y", "ot-gateway\@$ENV{VERSION}"/' plugins/ot-gateway/.mcp.json
  perl -pi -e 's/"version": "[^"]*"/"version": "$ENV{VERSION}"/' plugins/ot-gateway/.claude-plugin/plugin.json
  grep -qF "\"ot-gateway@$version\"" plugins/ot-gateway/.mcp.json || {
    echo "plugins/ot-gateway/.mcp.json has no \"-y\", \"ot-gateway@...\" to move: pin ot-gateway@$version by hand" >&2
    exit 1
  }
  grep -qF "\"version\": \"$version\"" plugins/ot-gateway/.claude-plugin/plugin.json || {
    echo "plugins/ot-gateway/.claude-plugin/plugin.json has no \"version\" to move: set it to $version by hand" >&2
    exit 1
  }
  moved=("${docs[@]}" "${plugin[@]}")
else
  echo "$tag is a prerelease: the plugin keeps its release." >&2
  moved=("${docs[@]}")
fi

echo "Pins moved from ${old} to ${tag}:"
git --no-pager diff --stat -- "${moved[@]}" 2>/dev/null || printf '  %s\n' "${moved[@]}"
