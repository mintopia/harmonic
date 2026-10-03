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
- whether its tracker is on and how often it polls, which tracker it uses,
  which forge hosts its code, and its [triage labels](#integrations),
- whether the Auto-Runner is on for it,
- whether agents may send each other messages, and how many each may send,
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

## Integrations

A Workspace's **Integrations** tab has three sections. Each is per
Workspace; there is nothing to set globally.

### Issue tracker

Harmonic finds a Workspace's tracker in this order, and the section shows
which one won on the **Resolved** line:

1. **Configured**: the tracker you pick here.
2. **Detected**: the one named in the repo's `docs/agents/issue-tracker.md`.
3. **Code Repository**: the forge hosting the code, when it is also an
   issue tracker.

Leave **Configured Tracker** on *Inherit (automatic)* to use the repo's
declaration. Otherwise pick GitHub, GitLab, Forgejo, Jira or Local Markdown;
the fields below the picker change with the choice.

- **GitHub** and **GitLab** have no credentials in Harmonic. They use the
  `gh` / `glab` login already on the host. GitLab's one field, **Project**,
  defaults to the `origin` remote.
- **Forgejo** needs **Base URL** and **Repo** (`owner/name`), an **Epic
  source** (labelled issues, Projects or Milestones), and a token. The
  **Secret** row shows *Set* or *Not set*; use **Set** or **Replace** to enter
  the token and **Clear** to remove it.
- **Jira** needs **Base URL**, **Auth mode** (Cloud or Data Center),
  **Email** (Cloud only), **Project key** and **Secret name**, plus optional
  extra JQL and the pickup, done and reopen status names.

A **Secret** is write-only. Once saved it is never shown again, it applies
immediately without the save bar, and it belongs to that Workspace only.

**Verify tracker** is disabled while you have unsaved edits.

### Code repository

The forge that hosts this Workspace's branches, pull requests and merges. It
is detected from the `origin` remote and shown under **Detected**. Use
**Override** to choose GitHub, GitLab or Forgejo yourself, and **Verify
repository** to check it is reachable. The code repository can differ from the
tracker, for example Jira issues with code on GitHub.

### Triage labels

The label names your tracker uses for each role Harmonic acts on: **Ready for
agent**, **Ready for human**, **Epic** and **Wayfinder map**. Leave a field
empty to inherit it from the repo's `docs/agents/triage-labels.md`, then the
defaults shown as placeholders.

## Archive & Export

The **Archive & Export** tab controls how long Harmonic keeps each task's
Archive and where finished tasks are exported. For what the Archive holds
and what an Export contains, see [Archive & export](/harmonic/work/archive-and-export/).

Every field on this tab can be overridden per Workspace. In a Workspace's
settings, each field shows the global value marked *Inherited from global
default*. Turn on its **Override** switch to set a value for that Workspace;
**Reset to default** puts it back.

### Archive retention

Both fields are blank by default, which keeps every Archive forever.

- **Keep for (days)**: delete Archives older than this.
- **Max total size (MB)**: once Archives pass this size, delete the oldest
  until they fit.

The **Archive retention** Scheduled Job applies these limits every hour. It
skips tasks still in progress, tasks that finished in the last hour, and
tasks whose Export has failed or is waiting on a retry. A Workspace with its own
limits is pruned separately from the others.

### Export

- **Export on terminal disposition**: off by default. Turn it on to export
  each task when it finishes.
- **Dispositions to export**: *done*, *cancelled* and *deleted*, all on by
  default. A deleted task is only exported if an agent worked on it.

Exporting never holds up or reverses the task.

### Export Destinations

Each Destination has its own on/off switch and gets its own copy of every
Export.

- **Directory**: a **Path** on the Harmonic host. Harmonic creates it if it
  is missing and never overwrites a file in it.
- **S3-compatible**: AWS S3, MinIO or another S3-compatible store. Fill in
  **Endpoint**, **Region**, **Bucket** and **Prefix**, and turn on **Force
  path-style** if your store needs it.

**Access key ID** and **Secret access key** are optional. Leave both blank
to use the AWS default credential chain on the host. Once saved, the keys
are masked and never shown again; use the replace control to change them.

**Test Destination** writes a probe file and removes it, then shows
*Wrote and removed probe object* or the error. Save your changes first; the
button is disabled while there are unsaved edits.

Failed deliveries and failed Export builds retry after 5 minutes, 30 minutes
and 2 hours. After that, use **Export again** on the ticket page.

### Redaction patterns

The **Baseline** list shows the six patterns that always run: AWS access
keys, AWS secret keys, GitHub tokens, GitLab tokens, bearer tokens and `sk-`
API keys. You can't remove them.

Under **Added patterns**, click **+ Add pattern** and give an id (lowercase
letters, digits and dashes, unique) and a regular expression. Harmonic
rejects an invalid expression when you save. A match is replaced with
`[REDACTED:<id>]`. Patterns added in a Workspace run alongside the global
ones.

Redaction only applies to Exports. The Archive on disk stays raw.

## See also

- [Feeding it work](/harmonic/work/feeding-it-work/)
- [Notifications](/harmonic/work/notifications/)
- [Archive & export](/harmonic/work/archive-and-export/)
