---
title: Security
description: Set an operator password, choose a safe host binding, and understand what "ungated" means before exposing Harmonic on a network.
---

Harmonic drives coding agents with real access to your repositories and
machine, so who can reach it matters. Two controls decide that: the
**operator password** and the **host binding**. This page covers both,
and the ungated default you should understand before exposing Harmonic
beyond your own machine.

:::danger
With no password set, Harmonic runs **ungated**. Anyone who can reach
the address has full access to every Workspace, Task, and Run, and can
start agents against your code. The default bind (`0.0.0.0`) is reachable
from your whole network. Set a password **or** bind to `127.0.0.1` before
exposing it.
:::

## The operator password

Harmonic uses single-operator auth: one password gates the web UI, and
named bearer API keys gate the REST API and MCP server. Set the password
when you start the server:

```sh
harmonic start --password 'a long passphrase'
```

You can also supply it as the `HARMONIC_PASSWORD` environment variable,
handy for a service unit or container. The command-line flag wins if both
are set (see the
[Configuration reference](/harmonic/reference/configuration/)).

A few things to know about how it behaves:

- **It persists.** The password is stored (scrypt-hashed, never in plain
  text) in the database. Once set, later starts that omit `--password`
  and `HARMONIC_PASSWORD` leave it in place; omitting it does **not**
  revert to ungated.
- **Setting it again rotates it.** Passing a new value replaces the
  stored password. (Changing it from the running app's Settings page also
  signs out other active sessions; sessions are in-memory, so a restart
  clears them regardless.)
- **Minimum length is 4 characters.** A shorter value is rejected.

### Removing the password

To go back to ungated, clear it explicitly with an empty value:

```sh
harmonic start --password ''
```

Only do this on a trusted, local-only binding.

## Host binding

`--host` controls which interfaces the server listens on:

| Binding | Reachable from | Use when |
| --- | --- | --- |
| `0.0.0.0` (default) | Your whole network | You've set a password and want to reach Harmonic from other devices. |
| `127.0.0.1` | The local machine only | You want a local-only instance with no network exposure. |

```sh
harmonic start --host 127.0.0.1     # local-only
```

The default `0.0.0.0` is convenient but exposed: combined with no
password, it means anyone on your network has full access. If you keep
the default binding, set a password.

## The ungated warning

When you start with no password, Harmonic warns you. On the default
`0.0.0.0` binding, `harmonic serve` prints:

```text
No operator password set — Harmonic is running ungated and reachable on 0.0.0.0.
  Anyone who can reach this address has full access. Bind to 127.0.0.1 or set a password.
  Set one any time: harmonic serve --password <password>   (or HARMONIC_PASSWORD)
```

On a loopback binding (`127.0.0.1`, `::1`, or `localhost`) Harmonic drops
the middle "anyone who can reach this address" line, printing only the
first and last.

One caveat: with `harmonic start` (the recommended background flow) this
warning is written to the daemon's log at `<data-dir>/harmonic.log`, not
your terminal. If you rely on seeing it, run `harmonic serve` in the
foreground once, or check the log after starting.

Treat it as a checklist. Ungated on `127.0.0.1` is a reasonable local
default; ungated on `0.0.0.0` is an open door.

## Recommended setups

| Situation | Binding | Password |
| --- | --- | --- |
| Just you, on your own machine | `127.0.0.1` | Optional |
| Reachable from other devices / a shared network | `0.0.0.0` | **Required** |
| Exposed through a reverse proxy or tunnel | `127.0.0.1` (proxy fronts it) | **Required** |

## See also

- [Configuration reference](/harmonic/reference/configuration/): the
  `--password` / `--host` options and their environment variables.
- [CLI reference](/harmonic/reference/cli/): every command and option.
- [Settings & overrides](/harmonic/using-harmonic/settings-and-overrides/):
  Permission Rules and the other in-app security settings.
