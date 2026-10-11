---
title: CLI reference
description: Every Harmonic command and option — standalone, service, and server-management commands.
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
| `install` | Install Harmonic as an OS service. Run `harmonic install --help` for the available options and platform-specific details. |
| `status` | Report whether a background server is running, and where. Exits **non-zero** if it isn't, usable in scripts. |
| `stop` | Stop the background server started with `start`. |
| `restart` | Restart the installed service, or the background server started with `start`. |
| `version` | Print the installed version. Also `--version` or `-v`. |
| `help` | Show usage. Also `--help`, or running with no command. |

## Standalone or installed service

Run Harmonic standalone when you want to manage its lifetime yourself:
use `harmonic serve` to keep it in the foreground, or `harmonic start` to
run its background daemon. Use `harmonic install` when you want your OS to
manage Harmonic as a service instead. For service setup and options, run
`harmonic install --help`.

Only one standalone background server runs per data directory. `start` launches it,
`status` inspects it, and `stop` shuts it down. All three read the same
`--data-dir` to find each other, so pass a matching `--data-dir` to every
command when you run off the default.

`restart` stops and starts the server again. If an installed service exists,
it restarts that service. Otherwise, if a background server is running, it
restarts that server on the same port and host. If nothing is running, it
starts a background server with the default port (`4700`) and host (`0.0.0.0`).
`restart` accepts only `--data-dir`, like `status` and `stop`.

## Options

| Option | Commands | Default | Description |
| --- | --- | --- | --- |
| `--port <n>` | `serve`, `start` | `4700` | Port to listen on. |
| `--host <h>` | `serve`, `start` | `0.0.0.0` | Bind address. `0.0.0.0` is reachable from your network; use `127.0.0.1` for local-only. |
| `--data-dir <dir>` | all | `~/.harmonic` | Where Harmonic keeps its data and background log. |
| `--password <pw>` | `serve`, `start` | — | Set or update the operator password. Pass an empty value (`--password ''`) to remove it and run **ungated**. |

`--data-dir` applies to every command, including `status` and `stop`,
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
harmonic start   --password 'correct horse' --data-dir ~/harmonic-work
harmonic status  --data-dir ~/harmonic-work
harmonic restart --data-dir ~/harmonic-work
harmonic stop    --data-dir ~/harmonic-work
```

Remove a previously set password (run ungated again):

```sh
harmonic start --password ''
```

## Staying up to date

Harmonic checks npm once an hour (and once at startup) using your npm
config, so a private registry or mirror works. When a newer release is out,
a banner appears in the app. Dismiss it to hide a version you're not ready
for; the next release brings it back.

Installed as an OS service (`harmonic install`, systemd or init.d),
Harmonic upgrades itself. Click Upgrade and, the next time your fleet is
idle, it installs the new release alongside the current one, checks it,
and switches over, so nothing is interrupted mid-flight. If the new release
keeps failing to start, it switches back to the previous one when the
pre-upgrade database can still be restored. The
[README](https://github.com/mintopia/harmonic#if-an-upgrade-fails) covers
what to check when an upgrade fails.

Run any other way (a global install with `harmonic start`, `npx`, pm2,
Docker), Harmonic doesn't upgrade itself, because it can't restart safely
under a supervisor it doesn't control. The banner shows the command to run
instead. From a source checkout Harmonic doesn't self-update; pull and
rebuild instead.

Upgrading the package by hand (`npm i -g`) replaces the files on disk, but
the running server keeps the old version until it restarts. Run
`harmonic restart` to switch over. Until then, a banner says which version is
installed and which is still running, and some pages may not work. If the
server was upgraded while a tab was open, the banner offers a Reload instead.

A restart signs everyone out. Sessions are kept in the server's memory, so
when a password is set, open tabs return to the Login screen after the server
restarts, and you sign in again with the same password.

## See also

- [Configuration reference](/run/configuration/): the
  environment variables (`HARMONIC_DATA_DIR`, `HARMONIC_PASSWORD`) that
  back these options, and what lives in the data directory.
- [Security](/run/security/): the password, host
  binding, and what "ungated" means before you expose Harmonic.
- [Quickstart](/start/quickstart/): install and run from scratch.
