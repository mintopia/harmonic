#!/usr/bin/env bash
# Usage: harness-image-verify.sh <image>
# Runs each Harness's version command inside the image and checks the pinned versions.
set -euo pipefail
image="${1:?usage: harness-image-verify.sh <image>}"
dockerfile="$(dirname "$0")/../docker/harnesses/Dockerfile"

pin() { sed -n "s/^ARG $1=//p" "$dockerfile"; }
run() { docker run --rm --entrypoint "" "$image" "$@"; }

run git --version

for spec in \
  "@agentclientprotocol/claude-agent-acp $(pin CLAUDE_AGENT_ACP_VERSION) claude-agent-acp" \
  "@agentclientprotocol/codex-acp $(pin CODEX_ACP_VERSION) codex-acp"; do
  read -r pkg want bin <<<"$spec"
  got="$(run npm ls -g --depth=0 --json | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.dependencies[process.argv[1]]?.version??"")' "$pkg")"
  [ "$got" = "$want" ] || { echo "FAIL $pkg: want $want, got '$got'" >&2; exit 1; }
  run sh -c "command -v $bin" >/dev/null || { echo "FAIL $bin not on PATH" >&2; exit 1; }
  echo "ok $pkg $got"
done

out="$(run copilot --version)"; echo "copilot: $out"
grep -qF "$(pin COPILOT_VERSION)" <<<"$out" || { echo "FAIL copilot version" >&2; exit 1; }
out="$(run opencode --version)"; echo "opencode: $out"
grep -qF "$(pin OPENCODE_VERSION)" <<<"$out" || { echo "FAIL opencode version" >&2; exit 1; }
