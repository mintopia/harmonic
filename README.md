# Harmonic

Queue, run, and review autonomous coding-agent tasks. Harmonic drives
agent harnesses (Claude Code, Codex, Copilot) over [ACP](https://agentclientprotocol.com)
from one board: agents run unattended, nothing merges without passing
the review gate.

## Run

No npm package — run straight from GitHub:

```sh
npx github:mintopia/harmonic serve
```

The first run clones and builds (a minute or two); after that it starts
instantly from the npx cache. Then open http://localhost:4700.

To run it in the background instead:

```sh
npx github:mintopia/harmonic start     # logs to ~/.harmonic/harmonic.log
npx github:mintopia/harmonic status
npx github:mintopia/harmonic stop
```

Useful flags and environment:

- `--port <n>` — port to listen on (default 4700)
- `--host <h>` — bind address (default `0.0.0.0`: reachable from your
  network; use `127.0.0.1` for local-only)
- `--data-dir <dir>` — where the SQLite database lives (default `~/.harmonic`)
- `HARMONIC_PASSWORD` — set an operator password (or `--password`). Optional:
  with none set Harmonic runs ungated, so bind to `127.0.0.1` or set one before
  exposing it on your network
- `HARMONIC_DATA_DIR` — same as `--data-dir`

## Development

```sh
npm install
npm run dev        # serve from source (tsx)
npm test           # vitest suite
npm run typecheck
```

Architecture decisions are recorded in [docs/adr/](docs/adr/), product
and design ground rules in [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).

## License

MIT
