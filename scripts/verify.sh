#!/usr/bin/env bash
# Gate code quality: lint + typecheck. Exit non-zero if either fails.
# Runs both even when the first fails, so one pass surfaces every problem.
set -uo pipefail

cd "$(dirname "$0")/.."

# A disposable verify worktree has no node_modules; link it from the repo's
# main worktree (found via git, so no path is hardcoded) so deps resolve.
# If the main worktree has none either, fall back to a clean install.
if [ ! -e node_modules ] && [ ! -L node_modules ]; then
  common=$(git rev-parse --git-common-dir 2>/dev/null) || common=""
  main_nm=""
  [ -n "$common" ] && main_nm="$(cd "$common/.." && pwd)/node_modules"
  if [ -n "$main_nm" ] && [ -d "$main_nm" ]; then
    ln -s "$main_nm" node_modules
  else
    npm ci --prefer-offline --no-audit --no-fund 
  fi
fi

status=0

run() {
  local name="$1"; shift
  echo "==> ${name}"
  if "$@"; then
    echo "    ${name}: ok"
  else
    echo "    ${name}: FAILED"
    status=1
  fi
  echo
}

run "lint"      npm run --silent lint
run "typecheck" npm run --silent typecheck

if [ "$status" -eq 0 ]; then
  echo "verify: all checks passed"
else
  echo "verify: one or more checks FAILED"
fi

exit "$status"
