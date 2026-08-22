---
title: Glossary
description: One-line definitions for every term in Harmonic's domain model, from Workspace and Task to Run Key and Process Tree.
---

This page is the reference form of Harmonic's vocabulary: short,
precise definitions for every domain term. For the narrative version of
how these pieces fit together, read
[Core concepts](/harmonic/using-harmonic/core-concepts/); for a
hands-on first walk, see
[Getting started](/harmonic/using-harmonic/getting-started/).

## Workspaces

**Workspace.** A named Working Directory (a repo root), unique by
absolute path: the container for a board of Tasks and Conversations
bound to that directory, its own execution settings, and its own
Tracker poll loop. One Harmonic instance hosts many; there is always at
least one, and the last cannot be deleted. Deleting a Workspace is
guarded against in-flight work and cascades to its Tasks, Runs, and
Conversations.

**Machine Ceiling.** The global cap on total concurrent Runs across
all Workspaces: the machine's safety limit that a Workspace's own
concurrency cap can never breach.

**Setting Override.** An overridable setting that resolves as
`Workspace value ?? global default`. The overridable ones are the Task
defaults (Harness, model, Isolation Mode, Priority) and a Workspace's
concurrency cap. A Workspace stores *inherit* until it sets an explicit
value, which *reset to default* clears back to inherit. Global-only
settings (Harnesses, prices,
Notification Channels, Permission Rules, API Keys, the Drive Prompt,
the Machine Ceiling) have no Workspace form; Workspace-only settings
(name, Working Directory, Tracker enable/interval, Auto-Runner enable)
have no global form.

## Tasks

**Task.** A unit of autonomous work: a prompt plus execution settings
(Harness, model, Working Directory, Isolation Mode) that moves through
a lifecycle.

**Run.** One execution attempt of a Task by a Harness, owning its own
event stream, Usage, and result. A retry is a new Run.

**Run Event.** One ACP `session/update` (message chunk, thought, tool
call, plan update) persisted against a Run; the source of truth for
observability.

**Dependency.** A directed edge between Tasks: the dependent stays
*blocked* until every Task it depends on is *completed*. Failed
dependencies leave dependents blocked and flagged, and nothing cascades
automatically.

**Priority.** A per-Task rank (high / normal / low) used only by the
Auto-Runner's pick order; ties break FIFO by creation time.

## Tracker mirroring

**Resolved Tracker.** Which issue tracker a Workspace's repo declares,
whether GitHub, GitLab, or Local Markdown, resolved from its
`docs/agents/issue-tracker.md` at poll time, never auto-detected.
Surfaced read-only on the Workspace. A resolution failure stops the
poll loop from starting rather than erroring every cycle.

**Origin.** Whether a Task was authored in Harmonic (native) or is a
1:1 projection of a tracker issue (mirrored). One board carries both;
only the origin differs.

**Mirrored Task.** A Task bound 1:1 to a tracker issue by a tracker
ref. The tracker owns its shape (prompt, blocking, workflow role) and
is the source of truth; Harmonic owns its execution state (Runs, Usage)
and writes only claim/close back. A re-poll upserts it. Never enters
*draft* and never enters *awaiting-review*.

**Map.** The mirror of a `wayfinder:map` issue: a derived grouping of
the mirrored Tasks that share its `mapRef`. Not a Task and not a stored
entity, but a query-time roll-up over the polled tracker.

**mapRef.** On a mirrored Task, the tracker ref of the parent Map
issue; absent on native Tasks and on mirrored issues that belong to no
Map.

**Workflow.** Which mattpocock workflow a mirrored issue belongs to:
wayfinder (charting a Map and its decision tickets) or implement
(build tickets from `/to-tickets`). Derived from labels.

**Wayfinder Type.** The kind of a `workflow = wayfinder` decision
ticket: research, prototype, grilling, or task. Null for implement
Tasks.

**Drive.** Who drives a mirrored Task: afk (Harmonic auto-runs it) or
hitl (a human drives it via the mattpocock skills; Harmonic surfaces it
but never runs it). Stored and mutable, seeded from labels. It's the
Auto-Runner's whole predicate for mirrored Tasks: pick-eligible iff
`drive ≠ hitl`. Mirrored Tasks bypass the review gate entirely, so
closure is a tracker act, never an Accept/Reject. The agent closing the
ticket via skill is the success signal; a Run that ends without closing
it is unresolved, so it is Auto-Retried, then Escalated.

**Escalation.** The runtime `afk → hitl` flip: when an afk Run blocks
on a human prompt, Harmonic stops the Run, sets *drive* to hitl, and
lands the Task back in *ready* flagged "escalated to human".

**Drive Prompt.** The prompt Harmonic injects to auto-run an afk
mirrored Task: a global settings template of a workflow slash-command
plus a short preamble, filled from the Task. The preamble tells the
agent to resolve the ticket end-to-end and comment + close it via the
tracker doc's `gh` mechanics.

**Merge Fate.** What becomes of a worktree Run's branch when an afk
mirrored Task is resolved: auto-merge (default), open-PR, or artifact.
Global default, per-Task override; worktree-only. Research findings
branches are always artifacts.

**Auto-Retry.** On an afk Run failure, Harmonic re-queues the Task to
*ready* as a fresh Run up to a configurable max (default 1), still afk;
exhausting the retries Escalates to hitl.

## Conversations

**Conversation.** An interactive, multi-turn exchange the operator
drives with a Harness in a Working Directory over ACP: a sibling to
Task, not a variant of it. Never queued, never picked by the
Auto-Runner, never enters the review gate; the human is in the loop for
every turn. It is active while its harness process is warm and ended
once explicitly ended, idle past the timeout, or killed by a server
restart. An ended Conversation survives as read-only history but
cannot resume.

**Turn.** One operator message and the Harness's response to it
within a Conversation: the interactive analogue of a Run's single
prompt turn.

**Permission Rule.** An operator-visible, revocable rule that
auto-answers a Harness's `session/request_permission` in a Conversation
without prompting the human. Matches on tool kind (read / edit /
execute / fetch) plus Working Directory. Persistent rules are a
deliberate opt-in.

## Lifecycle

**draft.** Being authored; never picked up for execution.

**blocked.** Has at least one Dependency not yet completed. Becomes
*ready* automatically when the last one completes.

**ready.** Eligible for execution, manually or by the Auto-Runner.

**running.** A Harness is currently executing a Run for it.

**awaiting-review.** The Run finished; a reviewer must Accept or
Reject.

**completed.** Terminal. The result was accepted; only this state
satisfies dependents.

**failed.** The Run errored, was interrupted by a restart, or the
result was rejected. Re-queueable to *ready*, optionally with feedback.

**cancelled.** Terminal. Abandoned deliberately.

**Accept / Reject.** The review decision on an *awaiting-review* Task.
Accept completes it (and in worktree mode merges the Run's branch into
its base branch; a conflict returns it to *awaiting-review*). Reject
fails it. Human-only unless the agent-review config flag is enabled.

## Execution

**Harness.** An agent CLI that Harmonic drives to execute Runs:
Claude (Claude Code), Codex, or Copilot, exclusively over ACP.

**Working Directory.** The directory where a Task's Runs execute: its
Workspace's directory, snapshotted onto the Task at creation so a
finished Run's record never shifts if the Workspace is later renamed,
repointed, or deleted.

**Isolation Mode.** How a Run touches its Working Directory: direct
(in place, unlocked) or worktree (a temporary git worktree on branch
`harmonic/task-<id>-run-<n>` off the base branch; the branch remains as
the artifact). Workspace default, per-Task override.

**Auto-Runner.** The single scheduler across all Workspaces. When a
Workspace has it enabled, it starts that Workspace's *ready* Tasks,
highest Priority first and FIFO within, up to the Workspace's own
concurrency cap, never exceeding the Machine Ceiling in total. A global
master switch gates all of them.

**Usage.** Token counts and tool-call tallies for a Run or
Conversation, parsed continuously from the Harness's native session
logs, the parent session plus every Subagent session, rolled up so
the parent's total includes its whole Process Tree. The source for Cost
and statistics.

**Subagent.** A nested agent a Harness spawns within a Run or
Conversation: itself a token-spending session with its own model and
Usage. Its Usage rolls up into the parent's. Claude and Copilot spawn
them; Codex does not.

**Process Tree.** A root process (a Run or Conversation) and its
recursive Subagents, each a node with its own model, Usage, context
fill, and live status. Derived per-Harness at read time; never stored.

**Harness Adapter.** The per-Harness code module behind which all
harness-specific knowledge lives: spawn tweaks, the model pin, and the
Usage Collector. Keyed by Harness.

**Usage Collector.** The per-Harness mechanism that parses the
Harness's native session logs into Usage and the Process Tree. Claude
and Codex read jsonl transcripts; Copilot reads its session store. Each
Harness has exactly one.

**Cost.** The API-equivalent dollar value of Usage: token counts
priced per model, always derived from Usage on demand, never stored. A
Task's Cost sums all its Runs. A model without a configured price
yields no Cost, and any aggregate containing it is flagged incomplete.
A Run's Cost includes its Subagents' tokens.

**AI Unit.** Copilot's native consumption unit (~$1 each), read
per-turn from Copilot's session store. Recorded on Usage and shown as
actual spend alongside Cost, a separate figure, not a Cost input.

## Interfaces

**Activity.** The instance-wide live view of every in-flight harness
process, Runs and active Conversations across all Workspaces,
showing realtime Usage, context fill, Cost, and each process's Process
Tree. Read-only but for a per-process Stop/Kill and a deep-link to a
related ticket.

**Dependency Graph.** A read-only, per-Workspace view (rail label
Graph) that lays out the board's Tasks as a directed acyclic graph over
their Dependency edges, native and mirrored alike. Active-state Tasks
by default, terminal ones behind a toggle. A node deep-links to its
Task; edits happen in Task detail.

**Notification Channel.** A configured destination, whether Discord
webhook, Slack webhook, Generic webhook, or Email, subscribed to a set
of event types, overridable per Task.

**API Key.** A named, revocable bearer token for the REST API and MCP
server. Full scope by default; a read scope mints a read-only variant.
Listing keys shows both, never the ephemeral Run/Conversation Keys.

**Read Key.** A read-scoped API Key for a viz client: it may GET
tasks, runs, and Maps and open the firehose WebSocket, but every
mutation and the operator surface is blocked. Operator-created and
listed like a full API Key.

**Run Key.** An ephemeral bearer token Harmonic mints per Run and
injects into the spawned Harness so agents reach MCP without setup.
Deleted when the Run finishes; never listed or shown.

**Conversation Key.** The Conversation analogue of a Run Key: an
ephemeral bearer token minted per Conversation and injected into its
Harness so the chatting agent can reach MCP. Deleted when the
Conversation ends; never listed or shown.
