#!/usr/bin/env bash
# Gate code quality: lint + typecheck. Exit non-zero if either fails.
# Runs both even when the first fails, so one pass surfaces every problem.
set -uo pipefail

cd "$(dirname "$0")/.."

# A disposable verify worktree has no node_modules; link it from the repo's
# main worktree (found via git, so no path is hardcoded) so deps resolve.
if [ ! -e node_modules ] && [ ! -L node_modules ]; then
  common=$(git rev-parse --git-common-dir 2>/dev/null) || common=""
  if [ -n "$common" ]; then
    main_nm="$(cd "$common/.." && pwd)/node_modules"
    [ -d "$main_nm" ] && ln -s "$main_nm" node_modules
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
