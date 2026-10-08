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
- prompts and prompt fragments (how Harmonic talks to agents and how agents
  talk to each other),
- the verification checks that run before a merge (commands and named
  critics, in the order you set),
- Routing Labels (see [Routing Labels](#routing-labels)),
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
- its [Routing Labels](#routing-labels): reorder or turn off the global ones
  and add its own,
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

## Prompts

The **Prompts** tab holds the prompts and prompt fragments Harmonic sends when
it runs work. Most fields can be overridden per Workspace. A Workspace field
reads *Inherited from global default* until you set its own value. Editing a
prompt or fragment affects the next time Harmonic sends it. A prompt already
sent is not rewritten; you can read it on the Task page (see
[Reviewing and merging](/harmonic/work/reviewing-and-merging/)).

### Task prompt

Wraps a native Task's own prompt before it goes to the agent. Placeholders are
filled per Task, and the default, a bare `{prompt}`, sends the prompt as
written. Mirrored tickets use the Drive prompt instead.

### Drive prompt

The prompt Harmonic sends when it runs a mirrored ticket unattended. The same
section holds these fields:

- **Unattended reminder**: appended to every auto-driven turn.
- **Continue prompt**: the re-prompt sent when a turn ends without the task
  finishing.
- **Commit nudge**: sent when an Attempt ends its turn with uncommitted changes.
- **Merge fate**: what happens to completed work. The options are
  **Merge automatically** (the default, merges the branch), **Open a pull
  request** (leaves the ticket open) and **Leave the branch** (for you or CI to
  pick up).
- **Continue attempts**: how many times Harmonic re-prompts an unfinished
  Attempt before treating it as unresolved.

### Pause message

Sent to a running Task when you pause it, asking the agent to finish its turn
and wait.

### Prompt fragments

Named pieces of prompt text, defined once and referenced from other prompts as
`{fragment.<name>}`. Each fragment shows its own description and the
placeholders it accepts. Some placeholders must stay in the text, and the page
tells you which. The fragments are:

- **Read-only restraint**, **Conflict resolution**, **Operator message**,
  **Self-heal**, **Prior session**, **Rebase conflict** and **Code index
  guidance**.
- **Peer messages section**, **Peer message entry**, **Peer line** and
  **Live peer message**, which shape how Attempts see each other's messages.
- **Critic role**, **Critic security notice**, **Critic ticket pointer**,
  **Critic instructions pointer**, **Critic specification (ticket)**, **Critic
  specification (instructions)**, **Critic uncommitted changes note**, the
  three **Critic revision block** variants and **Critic verdict contract**,
  which shape what a Critic is told and the reply it must give.
- **Failing Epic verification**, which describes a failed Epic verification to
  the agent fixing it.

If a fragment edit is rejected, the page tells you what the text must still
contain.

### Merge and Epic resolver prompts

What Harmonic sends to the agents that resolve merge conflicts and Epic
verification failures:

- **Merge conflict resolver**: opens each turn that resolves a Task merge
  conflict.
- **Epic merge conflict resolver**: opens each turn that resolves an Epic
  integration merge conflict.
- **Epic refresh resolver**: sent when the Epic integration branch is
  refreshed from the default branch and conflicts.
- **Epic verification resolver suffix**: appended to the Epic resolve prompt
  when the agent fixes a failing Epic verification.

Edits apply to the next resolver turn.

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

A Workspace's **Integrations** tab has three sections: **Issue Tracker**,
**Code Repository** and **Triage Labels**. Each is per Workspace; there is
nothing to set globally.

### Issue Tracker

The section starts with an **Enabled** switch (*Mirror tracker issues onto the
board*) and a **Poll interval (seconds)**, which can't go below 5.

Harmonic resolves a Workspace's tracker in this order. The **Resolved** line
at the bottom shows the result, for example *Resolved: Jira via Configured*:

1. **Configured**: the tracker you pick here.
2. **Detected**: the one named in the repo's `docs/agents/issue-tracker.md`.
3. **Code Repository**: the forge hosting the code, when it is also an
   issue tracker.

If no tracker is found, the line reads *No Tracker declared*, *Unsupported
Tracker* or *Tracker misconfigured*. While Enabled is off, it reads *Enable
mirroring to resolve the tracker*.

**Configured Tracker** starts on *Inherit (automatic)*, which uses the repo's
declaration. Otherwise pick GitHub, GitLab, Forgejo, Jira or Local Markdown.
Fields below change with the choice; required ones are marked *(required)*.

- **GitHub** has no fields. It uses the `gh` login already on the host.
- **GitLab** has one optional field, **Project**, which defaults to the
  repo's `origin` remote. It uses the `glab` login on the host.
- **Local Markdown** has one field, **Folder**, the folder in the repo that
  holds the Markdown tickets. It defaults to `.scratch`.
- **Forgejo** needs **Base URL** and **Repository (owner/name)**. **Epic
  source** chooses where Epics come from: labelled issues or
  Milestones, with labelled issues as the default. **Token Secret name** is
  the Secret that holds the API token and defaults to `FORGEJO_TOKEN`.
- **Jira** needs **Base URL**, **Auth mode** and **Project key**. Cloud signs
  in with an email and API token, so Cloud also needs **Email**. Data Center
  uses a personal access token. The optional fields are **Extra JQL**,
  **Pickup status**, **Done status** and **Reopen status**. **Token Secret
  name** is the Secret that holds the token and defaults to `JIRA_TOKEN`.

Forgejo and Jira show a **Secret** row for their token. It reads **Set** or
**Not set**. Use **Set** (or **Replace** when one exists) to type the value
and **Save**, or **Clear** to remove it. Secrets are write-only and take effect
immediately without the settings save bar. Each Secret is scoped to its
Workspace.

Secrets are encrypted with an instance-level key held in the data directory
(`secret.key`). Back up the data directory with your database to preserve
these credentials; losing the key file makes stored Secrets unreadable.

**Verify tracker** checks the connection and reports *Verified as* the
account, or the error. Disabled while you have unsaved edits; save first.

### Code Repository

The forge that hosts branches, pull requests and merges. **Detected** shows
what Harmonic found from `origin`, or *None detected from the origin remote*. **Override** starts on
*Automatic*; pick GitHub, GitLab, Forgejo or git to choose. **Verify
repository** reports *Reachable on* the forge or the error; disabled while you
have unsaved edits.

- **GitHub**, **GitLab** and **Forgejo** open PRs and merge them. GitHub and
  GitLab use the `gh` or `glab` login already on the host. Forgejo uses the
  Workspace Secret named by a Forgejo Configured Tracker on the same host,
  otherwise the Secret `FORGEJO_TOKEN`, which this card offers to set when no
  Forgejo tracker is configured.
- **git** is push-only: Harmonic pushes the branch but does not open a PR or merge.
  Use it for a host with no pull-request API.

The Code Repository can differ from the tracker, for example Jira issues with
code on GitHub.

### Triage Labels

The label names your tracker uses for each role Harmonic acts on: **Ready for
agent**, **Ready for human**, **Epic** and **Wayfinder map**. Leave a field
empty to inherit it from the repo's `docs/agents/triage-labels.md`, then the
defaults shown as placeholders.

## Routing Labels

A Routing Label maps a tracker label to a Harness and a Model, so the label
on a mirrored ticket decides which agent works it. For example, `reasoning`
can route to Claude with a stronger model, and `cheap` to a smaller one.
Native Tasks have no tracker labels, so they are never routed.

Set them on the **Execution** tab, under **Routing Labels**, next to the Task
defaults. Each row is a label, a Harness and a Model. Drag a row to reorder
the list. Labels are free text and match case-insensitively. A label can
appear only once in the list. The Harness picker lists the Harnesses you
have configured.

When an issue carries more than one routing label, the first one in the list
wins. The ticket's Harness and Model are chosen in this order:

1. The Harness or Model you set on the ticket yourself.
2. The Routing Label.
3. The Workspace default.
4. The global default.

### In a Workspace

Global rows are managed in Global settings. In a Workspace's settings you
can reorder them, turn individual ones off, and add labels that exist only in
that Workspace. You can't edit a global row there. To send a global label
somewhere else in one Workspace, turn the global row off and add a local row
with the same label. A label added globally later reaches Workspaces that have
already customised their list.

### When a route applies

- The route is worked out each time an Attempt starts, so relabelling a ticket
  and retrying runs the next Attempt on the new route. An Attempt already
  running is never moved. Changing the Harness starts a fresh agent Session,
  while changing only the Model keeps the warm one. When a relabel moves an
  Attempt to a different Harness or Model, the ticket's Activity records a
  *Route changed* event.
- An Epic's own turns (resolving it, Refresh, and merge conflicts) route by
  the Epic's own labels, not by whichever Member happens to be running.
- Verification Critics aren't routed. They keep the default Harness.

### What you see

A ticket on the Board shows a small *routed by* tag with the label next to its
Harness and model. The ticket page shows the same beside the Agent. If you set
the Harness or Model on the ticket yourself, the page says *set on this
Ticket* and shows the label struck through as not applied.

### When the Harness isn't configured

There is no fallback. If a route's Harness isn't configured (for example it
was removed after the label was saved), the ticket is escalated instead of
running on a default, and no Attempt starts. The ticket page names the label
and the Harness and offers two ways out:

- **Set Harness on this Ticket**, which overrides the label for that ticket
  only, or fix the problem for every ticket by configuring the Harness in
  Global settings under **Integrations**, **Harnesses**, or by changing the
  label's route.
- **Retry**, which starts a new Attempt once the problem is fixed.

## Agent Messages

Agents in the same Workspace can message each other. Off by default. Turn it on
and set caps on the **Execution** tab under **Agent Messages**.

- **Let Attempts message each other**: on/off switch.
- **Send cap**: how many messages one Attempt may send. Default 10, minimum 1.

Set both globally, then override either per Workspace; a Workspace shows the global value until you override it. For what operators
see when messaging is on, see [Agent Messages](/harmonic/work/agent-messages/).

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
- [Agent Messages](/harmonic/work/agent-messages/)
- [Archive & export](/harmonic/work/archive-and-export/)
