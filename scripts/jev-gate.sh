#!/usr/bin/env bash
# Jev code-quality gate — runnable straight from bash.
#   ./scripts/jev-gate.sh --base develop        # gate changed files
#   ./scripts/jev-gate.sh --write-baseline       # seed the whole-project baseline
#   ./scripts/jev-gate.sh --help
# Runs from the repo root regardless of where it's invoked, so the default
# jev.gate.json / jev.baseline.json paths resolve.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -x "node_modules/.bin/tsx" ]; then
  exec node_modules/.bin/tsx scripts/jev-gate/cli.ts "$@"
fi
exec npx --yes tsx scripts/jev-gate/cli.ts "$@"
