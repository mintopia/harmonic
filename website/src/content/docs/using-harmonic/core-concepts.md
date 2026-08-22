---
title: Core concepts
description: The Harmonic domain model — Workspaces, Tasks, Runs, Harnesses, the review gate, Isolation Mode, the Auto-Runner, and Dependencies.
---

Harmonic is built around a small set of ideas that recur everywhere in
the product. This page walks through them in plain language; for exact
one-line definitions of every term, see the
[Glossary](/harmonic/reference/glossary/). For a hands-on walk through
your first Task, see
[Getting started](/harmonic/using-harmonic/getting-started/).

## Workspaces

A **Workspace** is a named Working Directory, a repo root, unique by
its absolute path. It's the container for a board of Tasks and
Conversations bound to that directory, plus its own execution settings
(Task defaults, Auto-Runner, Tracker, Drive) and its own Tracker poll
loop. One Harmonic instance can host many Workspaces; there's always at
least one, and the last one can't be deleted.

Workspace settings can inherit from global defaults or override them.
Task defaults (Harness, model, Isolation Mode, Priority) and a
Workspace's concurrency cap all resolve as "Workspace value, or the
global default if unset." A handful of settings are global-only
(such as Harnesses, prices, and Notification Channels) or Workspace-only
(such as name, Working Directory, and Tracker/Auto-Runner enablement).

## Tasks, Runs & Harnesses

A **Task** is a unit of autonomous work: a prompt plus execution
settings: Harness, model, Working Directory, and Isolation Mode. It
moves through a lifecycle from creation to a terminal state.

A **Run** is one execution attempt of a Task. Each Run owns its own
event stream, Usage, and result. Retrying a Task means starting a new
Run, not reusing the old one.

A **Harness** is the agent CLI Harmonic drives to execute Runs, one of
Claude Code, Codex, or Copilot, always over the ACP protocol. While a Run is
in flight you can watch it live in the Activity view: message chunks,
thoughts, tool calls, and plan updates arrive as Run Events, alongside
running Usage and Cost.

## The lifecycle

Every Task sits in exactly one of eight states:

| State | Meaning |
| --- | --- |
| *draft* | Being authored; never picked up for execution. |
| *blocked* | Has at least one Dependency not yet completed. Becomes *ready* automatically once the last one completes. |
| *ready* | Eligible for execution, manually or by the Auto-Runner. |
| *running* | A Harness is currently executing a Run for it. |
| *awaiting-review* | The Run finished; a reviewer must Accept or Reject. |
| *completed* | Terminal. The result was accepted; only this state satisfies dependents. |
| *failed* | The Run errored, was interrupted by a restart, or was rejected. Re-queueable to *ready*, optionally with feedback. |
| *cancelled* | Terminal. Abandoned deliberately. |

## The review gate

When a Run finishes, its Task lands in *awaiting-review*. Nothing
merges or counts as done until a reviewer inspects the result and makes
a call:

- **Accept** completes the Task. In worktree mode, this also merges the
  Run's branch into its base branch; a merge conflict sends the Task
  back to *awaiting-review* instead of completing it.
- **Reject** fails the Task, which can then be re-queued to *ready*,
  optionally with feedback, for a fresh Run.

Accept/Reject is human-only unless the agent-review config flag is
enabled. One important exception: **mirrored Tasks**, those projected
1:1 from an issue tracker, bypass the review gate entirely. Closing
the tracker issue is the success signal for those, not Accept/Reject.

## Isolation Mode

**Isolation Mode** controls how a Run touches its Working Directory:

- **direct.** In place, unlocked.
- **worktree.** A temporary git worktree on branch
  `harmonic/task-<id>-run-<n>`, off the base branch. The branch remains
  afterward as the artifact of the Run.

It has a Workspace default, overridable per Task.

## The Auto-Runner & Priority

The **Auto-Runner** is the single scheduler across all Workspaces. For
each Workspace that has it enabled, it starts that Workspace's *ready*
Tasks, highest **Priority** (high / normal / low) first and FIFO within a
tier, up to the Workspace's own concurrency cap, and never past the
Machine Ceiling across the whole instance. A global master switch gates
the Auto-Runner everywhere at once.

## Dependencies

A **Dependency** is a directed edge between Tasks: the dependent stays
*blocked* until every Task it depends on reaches *completed*. Nothing
cascades automatically. If a dependency fails, its dependents stay
blocked and flagged until someone intervenes.

## Where to go next

For exact, one-line definitions of every term used above, plus the
vocabulary for tracker mirroring, Conversations, and execution
internals, see the [Glossary](/harmonic/reference/glossary/). To walk
through these pieces in action, start with
[Getting started](/harmonic/using-harmonic/getting-started/).
