#!/usr/bin/env bash
# Sets the checkout's permissions for a routine's sandbox (.github/actions/routine-agent,
# step "Sandbox"). The checkout becomes writable for the sandbox user, except .git,
# .github and .claude: they hold git's state and the scripts and settings the runner
# user executes, so only the runner user may change them.
#
#   routine-sandbox-perms.sh <workspace>
#
# scripts/test-routines.sh tests it.
set -euo pipefail

workspace=${1:?usage: routine-sandbox-perms.sh <workspace>}

chmod -R a+rwX "$workspace"
for dir in .git .github .claude; do
  if [ -d "$workspace/$dir" ]; then
    chmod -R go-w "$workspace/$dir"
  fi
done
