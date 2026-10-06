---
title: Security
description: Set an operator password and choose a safe host binding before exposing Harmonic on a network.
---

Harmonic drives agents with real access to your repositories and machine,
so who can reach it matters. Two settings decide that: an **operator
password** and the **host binding**.

:::danger
With no password set, Harmonic runs **ungated**, and the default bind
(`0.0.0.0`) is reachable from your whole network. Anyone who can reach the
address can start agents against your code. Set a password **or** bind to
`127.0.0.1` before exposing it.
:::

## Operator password

One password gates the web UI; named API keys gate the REST API. Set it
when you start:

```sh
harmonic start --password 'a long passphrase'     # or the HARMONIC_PASSWORD env var
```

- It's stored hashed and **persists**: later starts without the flag keep
  it, they don't revert to ungated.
- Setting a new value **rotates** it. Minimum length is 4 characters.
- To go back to ungated, clear it explicitly, and only on a local
  binding: `harmonic start --password ''`.

## Host binding

| `--host` | Reachable from | Use when |
| --- | --- | --- |
| `0.0.0.0` (default) | Your whole network | You've set a password. |
| `127.0.0.1` | The local machine only | Local-only, no network exposure. |

## Recommended setups

| Situation | Binding | Password |
| --- | --- | --- |
| Just you, on your own machine | `127.0.0.1` | Optional |
| Reachable from other devices | `0.0.0.0` | **Required** |
| Behind a reverse proxy or tunnel | `127.0.0.1` | **Required** |

See [CLI](/harmonic/run/cli/) and
[Configuration](/harmonic/run/configuration/) for the `--password` and
`--host` options, and [Settings & overrides](/harmonic/run/settings/) for
in-app Permission Rules.

## Browser access from another site

A separately hosted page, such as a dashboard that reads activity with an
API key, needs its origin allowed before the browser will let it call the
REST API. List those origins in `HARMONIC_CORS_ORIGINS`, comma-separated:

```sh
HARMONIC_CORS_ORIGINS='https://viewer.example.com' harmonic start
```

`*` allows any origin. Requests from an allowed origin still need an API
key, and Harmonic never allows credentialed cross-origin requests, so the
page can't use your login session. Give such pages a Read Key, which can
view work but change nothing.

## Secret key backup

Workspace tokens for Forgejo and Jira are encrypted with an instance key
stored in `secret.key` in the data directory. If the data directory is lost or
corrupted, back up this file along with the database to recover. If the key
file is lost, all stored tokens become unreadable.

## Server error references

When an unexpected server error occurs, the web UI shows a message like
`internal server error (ref abc123def456)`. Search the Harmonic log (usually
`~/.harmonic/harmonic.log` or `journalctl -u harmonic`) for that ref ID to
find the logged error with its full stack trace.
