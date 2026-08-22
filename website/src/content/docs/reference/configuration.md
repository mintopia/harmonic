---
title: Configuration reference
description: How Harmonic is configured from the command line and the environment — options, variables, precedence, and what lives in the data directory.
---

Harmonic's startup configuration comes from three places: command-line
options, environment variables, and built-in defaults. Everything else is
configured **inside the app** and stored in the database: harnesses, prices,
notifications, Permission Rules, and the rest. See
[Settings & overrides](/harmonic/using-harmonic/settings-and-overrides/)
for those.

## Options

Passed to the server commands (`serve`, `start`); `--data-dir` also
applies to `status` and `stop`. Full command coverage is in the
[CLI reference](/harmonic/reference/cli/).

| Option | Default | Description |
| --- | --- | --- |
| `--port <n>` | `4700` | Port to listen on. |
| `--host <h>` | `0.0.0.0` | Bind address. `0.0.0.0` is reachable from your network; `127.0.0.1` is local-only. |
| `--data-dir <dir>` | `~/.harmonic` | Directory holding the SQLite database, the daemon lock, and the background log. |
| `--password <pw>` | — | Set or update the operator password. `--password ''` removes it and runs ungated. |

## Environment variables

Two variables back the options above, for when setting an environment is
easier than passing a flag, such as in a service unit, a container, or a
shell profile:

| Variable | Equivalent to | Notes |
| --- | --- | --- |
| `HARMONIC_DATA_DIR` | `--data-dir` | State directory. |
| `HARMONIC_PASSWORD` | `--password` | Operator password. |

## Precedence

A command-line option always beats its environment variable, which beats
the built-in default:

```
--data-dir   >  HARMONIC_DATA_DIR   >  ~/.harmonic
--password   >  HARMONIC_PASSWORD   >  (none → ungated)
```

Because a passed option wins even when empty, `--password ''` overrides a
set `HARMONIC_PASSWORD` and clears the password. And because the password
is stored in the database once set, omitting both on a later start leaves
the existing password untouched. It does **not** revert to ungated. To
go ungated again you must explicitly clear it with `--password ''`.

## The data directory

Everything Harmonic persists lives under the data directory (default
`~/.harmonic`, or `--data-dir` / `HARMONIC_DATA_DIR`):

| File | What it holds |
| --- | --- |
| `harmonic.db` | The SQLite database: every Workspace, Task, Run, and setting. Runs in WAL mode, so you'll also see `harmonic.db-wal` and `harmonic.db-shm` alongside it. |
| `harmonic.pid` | The background daemon's lock/PID file. One background server runs per data directory; a second `serve`/`start` on the same directory is refused. |
| `harmonic.log` | Combined stdout and stderr from the background (`start`) server. |

To run two independent instances, give each its own `--data-dir`. `start`,
`status`, and `stop` all resolve the same `--data-dir` to find each other,
so pass a matching value to every command when you run off the default.

## See also

- [CLI reference](/harmonic/reference/cli/): every command and option.
- [Security](/harmonic/using-harmonic/security/): the password, host
  binding, and the ungated warning.
