---
title: Settings & overrides
description: What you can configure globally, per workspace, and per ticket — and how defaults flow down so you can change a whole board at once.
---

Harmonic settings live at three levels: **global** defaults for the whole
instance, **per-workspace** settings for one repo, and **per-ticket**
settings for a single piece of work. Lower levels inherit from higher ones
unless you set your own value, so you can steer one ticket or a whole board
with the same handful of controls.

## What you set where

**Global** (the settings page, header icon) — things that belong to the
whole instance:

- the harnesses and their models (see [Harnesses](/harmonic/run/harnesses/)),
- model prices (so cost is accurate),
- the verification checks that run before a merge (commands and named
  critics, in the order you set),
- notification channels,
- permission rules,
- security (the operator password),
- the machine-wide limit on how many agents run at once.

**Per workspace** — things about one repo:

- its name and folder,
- whether its tracker is on and how often it polls,
- whether the Auto-Runner is on for it,
- and its defaults for new tickets (harness, model,
  [isolation](/harmonic/work/branches-and-worktrees/), priority) and how
  many agents it may run at once.

**Per ticket** — override any of those defaults for a single ticket when
it needs something different.

## Defaults flow down

A workspace or ticket uses the level above it unless you give it its own
value; "reset to default" puts it back to inheriting. That's what makes
bulk changes easy:

- Change a **workspace's** default model, and every ticket that hasn't
  pinned its own model follows, so you can re-point a whole board in one
  edit.
- Pin a model on a **single ticket**, and only that ticket changes.

You can adjust a ticket's settings right up until it starts running, so
you can re-point something that's still waiting in the queue.

## How much runs at once

Each workspace has a cap on how many agents it runs at the same time, and
there's a machine-wide ceiling no workspace can exceed, so one busy repo
can't swamp the host. Separately, a **master switch** in the header pauses
or resumes all automatic running across every workspace at once, your
one-click way to grab the wheel.

## Permission rules

While you're chatting with an agent in a
[Conversation](/harmonic/work/conversations/), it asks before it edits a
file or runs a command. If you'd rather not be asked every time, a
**permission rule** lets an agent skip the prompt for a kind of action
(reading, editing, running, fetching) in a given workspace. Rules are
listed on the settings page and you can remove one whenever you want.

## Prices

Harmonic shows a running dollar **cost** on every agent's work, based on a
price per model. It already knows the models the built-in harnesses use.
If you add a model it doesn't have a price for, add that price too;
otherwise its work shows as cost-incomplete rather than a misleading zero.

## Archive & Export

When a Task reaches a terminal disposition — *done*, *cancelled*, or deleted
(after escalation) — Harmonic can export a redacted tarball of the Task's
Archive to one or more destinations for audit and archival.

### Archive retention

Archives are kept indefinitely by default. Set optional global limits:

- **Keep for (days)**: Automatically prune Archives older than this; blank = forever.
- **Max total size (MB)**: When Archives exceed this, oldest ones are deleted first; blank = unlimited.

Archives are never pruned while an Export is pending or failed.

### Enabling Export

Toggle Export on or off per workspace (global default: on). Choose which
terminal dispositions trigger an Export — all three are enabled by default
(*done*, *cancelled*, *deleted*).

An Export never blocks or reverts the disposition; failed Exports are
surfaced on the Ticket page.

### Export Destinations

Configure where Exports go; each destination is independent and receives a
copy. Choose one or both:

- **Directory**: An absolute path on the Harmonic host, created if missing. No file is ever overwritten.
- **S3-compatible**: An S3 bucket or MinIO/self-hosted equivalent with endpoint, region, bucket, prefix, and path-style addressing option.

S3 credentials are optional: leave both blank to use the AWS default credential chain. Credentials are always masked in the UI and never shown again after saving.

Both settings are global with a per-workspace override.

### Redaction patterns

Archives are redacted only at Export time; the local copy stays raw. Matches
are replaced with `[REDACTED:<pattern-id>]`.

Six baseline patterns are always on (AWS keys, GitHub and GitLab tokens,
bearer tokens, API keys).

Per-Workspace patterns add to baseline; you can't remove baseline patterns.
Invalid regular expressions are rejected on save.

### Testing and retrying

Click **Test Destination** to write and remove a probe object; the Settings
page shows success or the error.

Failed Exports retry automatically at 5 min, 30 min, and 2 h. If all retries
fail, the failure remains on the Ticket page; click **Export again** to
retry after fixing credentials.

## See also

- [Feeding it work](/harmonic/work/feeding-it-work/)
- [Notifications](/harmonic/work/notifications/)
