#!/usr/bin/env bash
# Installs the packed tarball the way installVersion does (--omit=dev) and boots it.
set -euo pipefail

cd "$(dirname "$0")/.."
work=$(mktemp -d)
server_pid=""
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

npm pack --pack-destination "$work" >/dev/null
tar -xzf "$work"/*.tgz --strip-components=1 -C "$work"
npm pkg delete devDependencies scripts.prepare --prefix "$work"
npm i --prefix "$work" --omit=dev --no-audit --no-fund

browser_only=$(node -e '
const dev = Object.keys(require("./package.json").devDependencies);
const web = ["@codemirror/language-data","@dnd-kit/core","@dnd-kit/sortable","@dnd-kit/utilities","codemirror","dompurify","elkjs","highlight.js","marked","marked-highlight"];
console.log(web.filter((n) => dev.includes(n)).join(" "));
')
for pkg in $browser_only; do
  if [ -e "$work/node_modules/$pkg" ]; then echo "browser-only package installed: $pkg" >&2; exit 1; fi
done

port=$((20000 + RANDOM % 20000))
node "$work/dist/cli.js" serve --host 127.0.0.1 --port "$port" --data-dir "$work/data" >"$work/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$port/" >/dev/null; then echo "booted OK on port $port"; exit 0; fi
  kill -0 "$server_pid" 2>/dev/null || { cat "$work/server.log" >&2; echo "server exited" >&2; exit 1; }
  sleep 1
done
cat "$work/server.log" >&2
echo "server did not become ready" >&2
exit 1
