---
title: Getting started
description: A hands-on walkthrough of your first Task in Harmonic, from creation through the review gate to Accept or Reject.
---

This page walks you through your first Task end to end: create it, run
it, review what came back, and decide whether it merges. By the end
you'll have seen the whole loop that every Task in Harmonic follows.

## Before you start

Harmonic is installed and running:

```
npm install -g @mintopia/harmonic
harmonic start
```

Open `http://localhost:4700`. Harmonic always has at least one
**Workspace** — a named Working Directory pointing at a repo root — so
there's somewhere for your first Task to live.

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

## What's next

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
