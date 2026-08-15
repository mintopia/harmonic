---
title: CLI reference
description: Every Harmonic command and option — serve, start, status, stop, help, and the flags that configure them.
---

The `harmonic` command manages the server. After a global install
(`npm install -g @mintopia/harmonic`) it's on your PATH; without one,
prefix any command with `npx @mintopia/harmonic`. Running `harmonic` with
no command, or with `help` / `--help`, prints usage.

```sh
harmonic <command> [options]
npx @mintopia/harmonic <command> [options]
```

## Commands

| Command | What it does |
| --- | --- |
| `serve` | Run the server in the **foreground** (Ctrl-C to stop). Best for a quick one-off. |
| `start` | Run the server in the **background**; logs to `<data-dir>/harmonic.log`. Returns immediately. |
| `status` | Report whether a background server is running, and where. Exits **non-zero** if it isn't — usable in scripts. |
| `stop` | Stop the background server started with `start`. |
| `help` | Show usage. Also `--help`, or running with no command. |

Only one background server runs per data directory. `start` launches it,
`status` inspects it, and `stop` shuts it down — all three read the same
`--data-dir` to find each other, so pass a matching `--data-dir` to every
command when you run off the default.

## Options

| Option | Commands | Default | Description |
| --- | --- | --- | --- |
| `--port <n>` | `serve`, `start` | `4700` | Port to listen on. |
| `--host <h>` | `serve`, `start` | `0.0.0.0` | Bind address. `0.0.0.0` is reachable from your network; use `127.0.0.1` for local-only. |
| `--data-dir <dir>` | all | `~/.harmonic` | Directory holding the SQLite database, the daemon lock, and the background log. |
| `--password <pw>` | `serve`, `start` | — | Set or update the operator password. Pass an empty value (`--password ''`) to remove it and run **ungated**. |

`--data-dir` applies to every command — including `status` and `stop`,
which use it to locate the running server. `status` and `stop` accept
**only** `--data-dir`; passing `--port`, `--host`, or `--password` to
them is an error and exits non-zero. Those three flags belong to the
commands that start a server (`serve`, `start`).

## Examples

Run in the foreground on a custom port, local-only:

```sh
harmonic serve --host 127.0.0.1 --port 8080
```

Start a password-protected background server with its own data directory:

```sh
harmonic start --password 'correct horse' --data-dir ~/harmonic-work
harmonic status --data-dir ~/harmonic-work
harmonic stop   --data-dir ~/harmonic-work
```

Remove a previously set password (run ungated again):

```sh
harmonic start --password ''
```

## See also

- [Configuration reference](/harmonic/reference/configuration/) — the
  environment variables (`HARMONIC_DATA_DIR`, `HARMONIC_PASSWORD`) that
  back these options, and what lives in the data directory.
- [Security](/harmonic/using-harmonic/security/) — the password, host
  binding, and what "ungated" means before you expose Harmonic.
- [Getting started](/harmonic/using-harmonic/getting-started/) — install
  and run from scratch.
</content>
