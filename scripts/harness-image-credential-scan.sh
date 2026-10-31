#!/usr/bin/env bash
# Usage: harness-image-credential-scan.sh <image>
# Exports the image filesystem and fails (exit 1) if it holds a credential.
set -euo pipefail
image="${1:?usage: harness-image-credential-scan.sh <image>}"
root="$(mktemp -d)"
cid="$(docker create "$image")"
trap 'docker rm -f "$cid" >/dev/null; rm -rf "$root"' EXIT
docker export "$cid" | tar -x -C "$root" --exclude='./dev/*' --exclude='./proc/*' --exclude='./sys/*' 2>/dev/null || true

found=0
report() { echo "CREDENTIAL: $1" >&2; found=1; }

while IFS= read -r f; do report "credential file ${f#"$root"}"; done < <(
  find "$root" \( -name .git-credentials -o -name .netrc -o -name .pgpass -o -name id_rsa \
    -o -name id_ed25519 -o -name id_ecdsa -o -name .credentials.json -o -name auth.json \
    -o -name .env -o -name '.env.*' \) -type f 2>/dev/null)

pattern='sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abp]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|_authToken=[^$[:space:]]{8,}'
while IFS= read -r f; do report "secret pattern in ${f#"$root"}"; done < <(
  grep -rIlE -e "$pattern" "$root" --exclude-dir=node_modules --exclude-dir=share 2>/dev/null || true)

[ "$found" = 0 ] && echo "credential scan clean: $image"
exit "$found"
