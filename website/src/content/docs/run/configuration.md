---
title: Configuration reference
description: How Harmonic is configured from the command line and the environment — options, variables, precedence, and what lives in the data directory.
---

Harmonic's startup configuration comes from three places: command-line
options, environment variables, and built-in defaults. Everything else,
harnesses, prices, notifications, permission rules, and the rest, is
configured **inside the app**; see
[Settings & overrides](/harmonic/run/settings/).

## Options

Passed to the server commands (`serve`, `start`); `--data-dir` also
applies to `status` and `stop`. Full command coverage is in the
[CLI reference](/harmonic/run/cli/).

| Option | Default | Description |
| --- | --- | --- |
| `--port <n>` | `4700` | Port to listen on. |
| `--host <h>` | `0.0.0.0` | Bind address. `0.0.0.0` is reachable from your network; `127.0.0.1` is local-only. |
| `--data-dir <dir>` | `~/.harmonic` | Where Harmonic keeps its data and background log. |
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

Everything Harmonic keeps, your workspaces, tickets, history, and
settings, lives under the data directory (default `~/.harmonic`), along
with the background log. Back up that folder to back up Harmonic, and
point it somewhere else with `--data-dir` or `HARMONIC_DATA_DIR`.

Only one server runs per data directory. To run two independent instances,
give each its own `--data-dir`, and pass the matching value to `status`
and `stop` so they act on the right one.

## See also

- [CLI reference](/harmonic/run/cli/): every command and option.
- [Security](/harmonic/run/security/): the password, host
  binding, and the ungated warning.
