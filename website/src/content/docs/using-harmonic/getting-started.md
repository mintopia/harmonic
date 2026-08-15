---
title: Getting started
description: Install Harmonic, run the background server, open it at localhost:4700, and walk your first Task through the review gate.
---

Install Harmonic, start the server, open it in a browser, and run your
first Task end to end. By the end you'll have Harmonic running and have
seen the whole loop every Task follows: create, run, review, decide.

## Install

Install from npm once and you get the `harmonic` command on your PATH:

```sh
npm install -g @mintopia/harmonic
```

Rather not install anything globally? Every command also works through
`npx`, which fetches and runs the latest release on demand:

```sh
npx @mintopia/harmonic start
```

The two are interchangeable everywhere on this page — use `harmonic <cmd>`
after a global install, or `npx @mintopia/harmonic <cmd>` without one.

## Run

The recommended way to keep Harmonic on hand is the background server.
`start` launches it detached and returns immediately, logging to
`harmonic.log` inside the data directory (`~/.harmonic` by default):

```sh
harmonic start          # background; logs to ~/.harmonic/harmonic.log
```

Manage that background server with:

```sh
harmonic status         # is it running, and where? (non-zero exit if not)
harmonic stop           # shut it down
```

For a quick one-off, run it in the **foreground** instead and stop it
with Ctrl-C:

```sh
harmonic serve
```

Both `serve` and `start` accept `--port`, `--host`, `--data-dir`, and
`--password`; see the [CLI reference](/harmonic/reference/cli/) for every
command and option, and the
[Configuration reference](/harmonic/reference/configuration/) for the
environment variables that back them.

## Open it

However you started it, open **`http://localhost:4700`** — the default
port. Harmonic always has at least one **Workspace** — a named Working
Directory pointing at a repo root — so there's somewhere for your first
Task to live.

:::caution
With no password set, Harmonic runs **ungated**: anyone who can reach the
address has full access, and the default `--host 0.0.0.0` is reachable
from your whole network. Before exposing it, bind to `127.0.0.1` or set a
password — see [Security](/harmonic/using-harmonic/security/).
:::

## 1. Create a Task

A **Task** is a prompt plus the execution settings that decide how it
runs: Harness, model, Isolation Mode, and Priority. Open a Workspace and
create a new Task with a prompt describing what you want done.

A Task you're still writing sits in *draft*; once you've finished it
and it has no unmet Dependencies, it lands in *ready* — eligible to run.
See [Dependencies](/harmonic/using-harmonic/core-concepts/#dependencies)
in Core concepts if your Task should wait on another one first.

One setting worth deciding up front is **Isolation Mode**:

- **direct** — the Run executes in place, in the Workspace's Working
  Directory, unlocked.
- **worktree** — the Run executes in a temporary git worktree on branch
  `harmonic/task-<id>-run-<n>`, checked out off the base branch. The
  branch is kept afterward as the artifact of the Run.

If you're not sure, worktree is the safer default — it keeps a Run's
changes isolated until you've reviewed them.

## 2. Run it

A *ready* Task can be started two ways: start it manually, or leave it
for the **Auto-Runner** to pick up. The Auto-Runner works through each
Workspace's *ready* Tasks highest Priority first, FIFO within a
Priority tier, up to that Workspace's concurrency cap — and only while
the global master switch is on.

Either way, the Task moves to *running*: a **Harness** (Claude Code,
Codex, or Copilot) executes a **Run** over ACP. While it's in flight,
open the Activity view to watch it live — message chunks, thoughts,
tool calls, and plan updates stream in as **Run Events**, alongside
live Usage and Cost.

## 3. Review at the gate

When the Run finishes, the Task lands in *awaiting-review*. This is the
heart of Harmonic: **nothing merges without passing the review gate.**
Open the Task to inspect the Run's output and diff before deciding what
happens next.

## 4. Accept or Reject

From *awaiting-review* you make the call:

- **Accept** completes the Task — a terminal state. In worktree mode,
  accepting also merges the Run's branch into its base branch; if that
  merge conflicts, the Task returns to *awaiting-review* rather than
  completing.
- **Reject** fails the Task. A failed Task can be re-queued to *ready*,
  optionally with feedback attached — a retry is simply a new Run.

Accept/Reject is a human-only decision unless your instance has the
agent-review config flag enabled.

## Where to go next

That's the full loop: create, run, review, decide. To see how these
pieces — Workspace, Task, Run, Harness, Isolation Mode, and the rest —
fit together as a model, read
[Core concepts](/harmonic/using-harmonic/core-concepts/). For quick
lookups of any term, see the
[Glossary](/harmonic/reference/glossary/).

One exception to note: mirrored Tasks — those projected 1:1 from an
issue tracker — bypass the review gate entirely. Closing the tracker
issue is what resolves them, not Accept/Reject. See
[Core concepts](/harmonic/using-harmonic/core-concepts/) for more.
</content>
</invoke>
