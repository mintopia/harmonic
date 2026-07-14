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

Useful flags and environment:

```sh
npx github:mintopia/harmonic serve --port 4700 --password <pass>
```

- `--data-dir <dir>` — where the SQLite database lives (default `~/.harmonic`)
- `HARMONIC_USERNAME` / `HARMONIC_PASSWORD` — login credentials
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
