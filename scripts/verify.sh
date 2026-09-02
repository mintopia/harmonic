#!/usr/bin/env bash
# Gate code quality: lint + typecheck. Exit non-zero if either fails.
# Runs both even when the first fails, so one pass surfaces every problem.
set -uo pipefail

cd "$(dirname "$0")/.."

# The command verifier runs this in a fresh detached git worktree that has no
# node_modules, so lint/typecheck cannot resolve local tooling or @types/node.
# Reuse the main worktree's install via a symlink; fall back to a clean install.
if [ ! -e node_modules ]; then
  main_root="$(cd "$(dirname "$(git rev-parse --git-common-dir 2>/dev/null || echo .)")" 2>/dev/null && pwd)"
  if [ -n "${main_root}" ] && [ -d "${main_root}/node_modules" ]; then
    ln -s "${main_root}/node_modules" node_modules
  else
    npm ci --prefer-offline --no-audit --no-fund --silent
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
