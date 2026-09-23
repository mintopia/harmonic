# Harmonic

Point Harmonic at your issue tracker and it works through your backlog on
its own. Write a spec, break it into tickets, and Harmonic runs the ready
ones out to merged code: for each ticket it starts a coding agent,
implements the change, has the work reviewed, and merges the branch,
handing a ticket back only when it needs a human. You watch a board and a
timeline of everything the fleet has run, and step in only when a ticket
needs you.

It's built to run alongside **Matt Pocock's Skills**, which turn a spec
into labelled tickets in your tracker; Harmonic is the layer that runs
them. It drives agent harnesses (Claude Code, Codex, Copilot, OpenCode)
over [ACP](https://agentclientprotocol.com), so they're interchangeable
with no vendor lock-in. You can also queue a one-off task by hand, with a
review gate you accept or reject before anything merges.

**Full documentation:** https://mintopia.github.io/harmonic

## Run

Needs Node.js 22+ and git — 2.38+ recommended so Harmonic can reconcile a
moved base branch without rebuilding the merge; an older git still works, it
just rebuilds on every base advance instead.

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

Harmonic checks npm hourly and shows a banner in the app when a newer release
is out. The check uses your npm config, so a private registry or mirror sees
the same versions `npm install` would. How it upgrades depends on how you run it:

- **As an OS service** (`harmonic install`, systemd or init.d): Upgrade in the
  banner installs the new release alongside the current one, checks it, then
  switches over the next time your fleet is idle. If the new release fails to
  start four times, Harmonic switches back to the previous release and restores
  the database from just before the upgrade, as long as that pre-upgrade copy
  can still be restored. If it can't (for example a missing snapshot), Harmonic
  stays on the failed release instead of risking a database the failed release
  may have already changed, and keeps retrying on every start. The reason is in
  the service log and `<data-dir>/app/rollback.json`; see
  [If an upgrade fails](#if-an-upgrade-fails) below.
- **Anything else** (a global install, `npx`, `harmonic start`, pm2, Docker):
  the banner shows the command to run, or tells you to reinstall the way you
  originally did when it can't tell how Harmonic was installed. Harmonic
  doesn't upgrade itself here, because it can't restart safely under a
  supervisor it doesn't control.

### If an upgrade fails

Check, in order:

- The service log: `journalctl -u harmonic` (systemd) or
  `<data-dir>/harmonic.log` (init.d/background).
- `<data-dir>/app/rollback.json` names why a rollback didn't happen and,
  when anything was moved aside, where.
- `<data-dir>/rolled-back/` holds the pre-upgrade database, preserved (never
  deleted) if it had to be moved aside during a rollback attempt.
- `<data-dir>/app/database-incomplete.json` exists only if a blocked
  rollback couldn't move every db/-wal/-shm file back to `<data-dir>`; it
  names the file(s) and where they ended up, and Harmonic refuses to start
  until you move them back and delete this file.

Once you've fixed the underlying cause (disk space, a missing snapshot, etc.),
restart the service. For systemd, repeated failures can trip the unit's
restart limit first, so fixing the cause alone may not be enough:

```sh
sudo systemctl reset-failed harmonic && sudo systemctl start harmonic
```

### Upgrading from 2.18.0 or 2.18.1

2.18.0 and 2.18.1 have a bug in the systemd upgrade. 2.18.2 repairs the upgrade
for you as it installs, unless npm is set to skip install scripts
(`ignore-scripts=true`). If it is, or if the service fails to start after
upgrading, upgrade by hand instead of using the banner:

```sh
sudo npm install -g @mintopia/harmonic@latest
sudo harmonic install
```

`harmonic install` keeps the existing service's port, host, data directory and
password.

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
| `install` | Install Harmonic as an OS service (systemd or SysV init.d) so it starts on boot. `harmonic install --help` for platform options. |
| `uninstall` | Remove the OS service and stop it. Leaves the data dir untouched. |
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
