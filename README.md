# Harmonic

Point Harmonic at your issue tracker and it works through your backlog on
its own. Write a spec, break it into tickets, and Harmonic runs the ready
ones out to merged code: for each ticket it starts a coding agent,
implements the change, has the work reviewed, and merges the branch,
handing a ticket back only when it needs a human. You watch a board — and a
timeline of everything the fleet has run — and step in only when a ticket
needs you.

It's built to run alongside **Matt Pocock's Skills**, which turn a spec
into labelled tickets in your tracker; Harmonic is the layer that runs
them. It drives agent harnesses (Claude Code, Codex, Copilot, OpenCode)
over [ACP](https://agentclientprotocol.com), so they're interchangeable
with no vendor lock-in. You can also queue a one-off task by hand, with a
review gate you accept or reject before anything merges.

**Full documentation:** https://mintopia.github.io/harmonic

## Run

Install it from npm once, then run it in the background — that's the
recommended way to keep Harmonic on hand:

```sh
npm install -g @mintopia/harmonic
harmonic start          # background; logs to ~/.harmonic/harmonic.log
```

Then open http://localhost:4700. Manage the background server with:

```sh
harmonic status         # is it running, and where?
harmonic stop           # shut it down
```

A global install keeps itself up to date. Harmonic checks npm hourly and,
when a newer release is out, shows a banner in the app, then upgrades in
place the next time your fleet is idle and relaunches on the new version.

Rather not install? Every command also works through `npx`:

```sh
npx @mintopia/harmonic start
```

For a quick one-off, run it in the foreground instead and stop it with
Ctrl-C:

```sh
harmonic serve
```

### Commands

| Command | What it does |
| --- | --- |
| `serve` | Run the server in the foreground (Ctrl-C to stop). |
| `start` | Run the server in the background; logs to `<data-dir>/harmonic.log`. |
| `status` | Report whether a background server is running (exits non-zero if not). |
| `stop` | Stop the background server. |
| `help` | Show usage. Also `--help`, or running with no command. |

### Options

| Option | Commands | Default | Description |
| --- | --- | --- | --- |
| `--port <n>` | `serve`, `start` | `4700` | Port to listen on. |
| `--host <h>` | `serve`, `start` | `0.0.0.0` | Bind address. `0.0.0.0` is reachable from your network; use `127.0.0.1` for local-only. |
| `--data-dir <dir>` | all | `~/.harmonic` | Directory holding the SQLite database and the background log. |
| `--password <pw>` | `serve`, `start` | — | Set or update the operator password. Pass an empty value (`--password ''`) to remove it and run ungated. |

### Environment

| Variable | Equivalent to | Notes |
| --- | --- | --- |
| `HARMONIC_DATA_DIR` | `--data-dir` | State directory. |
| `HARMONIC_PASSWORD` | `--password` | Operator password. |

With no password set, Harmonic runs **ungated** — anyone who can reach the
address has full access. Bind to `127.0.0.1`, or set a password, before
exposing it on your network.

## Development

```sh
git clone https://github.com/mintopia/harmonic
cd harmonic
npm install
npm run dev        # serve from source (tsx)
npm test           # vitest suite
npm run typecheck
```

While you work, run the relevant test file with `npx vitest run <file>`.
Before the final test run, use `npm run typecheck` and `npm run lint`. Run
`npm test` once when the work is complete. It starts ACP harnesses and covers
shared-lock behavior, so it is slower than a focused test.

Architecture decisions are recorded in [docs/adr/](docs/adr/), product
and design ground rules in [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md).

## License

MIT
