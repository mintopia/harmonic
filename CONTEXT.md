# Harmonic

A web application running inside a Coder workspace that executes autonomous
agent Tasks by driving agent Harnesses over ACP.

## Language

### Workspaces

**Workspace**:
A named Working Directory (a repo root), unique by absolute path — the
container for a board of Tasks and Conversations bound to that directory,
its own execution settings (Task defaults, Auto-Runner, Tracker, Drive), and
its own Tracker poll loop. One Harmonic instance hosts many; there is always
at least one, and the last cannot be deleted. Deleting one is guarded (no
in-flight work) and cascades to its Tasks, Runs, and Conversations.
_Avoid_: project, repo, context

**Machine Ceiling**:
The global cap on total concurrent Runs across all Workspaces — the machine's
safety limit that a Workspace's own concurrency cap can never breach.

### Tasks

**Task**:
A unit of autonomous work — a prompt plus execution settings (Harness,
model, Working Directory, Isolation Mode) that moves through a lifecycle.
_Avoid_: job, ticket, item

**Run**:
One execution attempt of a Task by a Harness, owning its event stream,
Usage, and result. A retry is a new Run.
_Avoid_: execution, attempt, session

**Run Event**:
One ACP `session/update` (message chunk, thought, tool call, plan update)
persisted against a Run; the source of truth for observability.
_Avoid_: log line, message

**Dependency**:
A directed edge between Tasks: the dependent stays *blocked* until every
Task it depends on is *completed*. Failed dependencies leave dependents
blocked and flagged — nothing cascades automatically.
_Avoid_: prerequisite, parent

**Priority**:
A per-Task rank (high / normal / low) used only by the Auto-Runner's pick
order; ties break FIFO by creation time.

### Tracker mirroring

**Origin**:
Whether a Task was authored in Harmonic (**native**) or is a 1:1 projection
of a tracker issue (**mirrored**). One board carries both; only the origin
differs.
_Avoid_: source, kind

**Mirrored Task**:
A Task bound 1:1 to a tracker issue by a tracker ref. The tracker owns its
shape (prompt, blocking, workflow role) and is the source of truth; Harmonic
owns its execution state (Runs, Usage) and writes only claim/close back. A
re-poll upserts it. Never enters *draft* — a tracker issue is already
authored — and never enters *awaiting-review* (see Drive).
_Avoid_: imported task, synced issue

**Map**:
The mirror of a `wayfinder:map` issue: a **derived** grouping of the mirrored
Tasks that share its `mapRef`. Not a Task (no prompt, Run, or review) and not
a stored entity (it holds no Harmonic-native state) — a query-time roll-up
over the polled tracker. Reuses wayfinder's own term.
_Avoid_: effort, epic, project

**mapRef**:
On a mirrored Task, the tracker ref of the parent Map issue; absent on native
Tasks and on mirrored issues that belong to no Map.

**Workflow**:
Which mattpocock workflow a mirrored issue belongs to — **wayfinder**
(charting: a Map and its decision tickets) or **implement** (build tickets
from `/to-tickets`). Distinct skills, distinct roles, never conflated.
Derived from labels.
_Avoid_: pipeline, mode

**Wayfinder Type**:
The kind of a `workflow = wayfinder` decision ticket: *research*, *prototype*,
*grilling*, or *task*. Null for *implement* Tasks — "implementation" is a
Workflow, never a Wayfinder Type.

**Drive**:
Who drives a mirrored Task — **afk** (Harmonic auto-runs it) or **hitl** (a
human drives it via the mattpocock skills; Harmonic surfaces it but never
runs it). Stored and mutable. Seeded from labels (ready-for-human / grilling /
prototype / bare-task → hitl; ready-for-agent / research → afk); an
**unclear** signal seeds *afk* — attempt optimistically. The Auto-Runner's
whole predicate: pick-eligible iff `drive ≠ hitl`. Mirrored Tasks bypass the
review gate entirely — closure is a tracker act (the agent via its skill,
Harmonic as fallback on clean completion, or a human), never an Accept/Reject.
_Avoid_: mode, assignee

**Escalation**:
The runtime `afk → hitl` flip: when an afk Run blocks on a human prompt (a
permission request or a clarifying question), Harmonic stops the Run, sets
*drive* to hitl, and lands the Task back in *ready* flagged "escalated to
human" so the Auto-Runner skips it and a person takes over.
_Avoid_: downgrade, fallback, handoff

**Drive Prompt**:
The prompt Harmonic injects to auto-run an afk mirrored Task: a **global**
settings template (no per-Task override) of a workflow slash-command plus a
short preamble, filled from the Task — `{skill}` from its Workflow /
Wayfinder Type (research→`/research`, implement→`/implement`), plus `{ref}`
`{url}` `{title}` `{body}`. The preamble tells the agent to resolve the ticket
end-to-end and comment + close it via the tracker doc's `gh` mechanics; the
skills stay the source of truth. The Run then streams Run Events like any Run
— no separate visibility path.
_Avoid_: injected command, auto-prompt

**Merge Fate**:
What becomes of a worktree Run's branch when an afk mirrored Task completes
cleanly — **auto-merge** (default: merge into base on clean completion; a
conflict Escalates rather than awaiting-review, which mirrored Tasks lack),
**open-PR** (branch → GitHub PR, review off-Harmonic), or **artifact** (leave
the branch for a human/CI). Global default, per-Task override; worktree-only
(direct isolation has no branch). Research findings branches are always
artifacts regardless.
_Avoid_: merge policy

**Auto-Retry**:
On an afk Run failure (an error, or the skill's own `/code-review` rejecting
the work) Harmonic re-queues the Task to *ready* as a fresh Run up to a
configurable max (default 1), still afk; exhausting the retries Escalates to
hitl (Run *failed*, drive→hitl, ticket open + un-assigned + flagged), never a
silent retry beyond the cap.
_Avoid_: auto-requeue

### Conversations

**Conversation**:
An interactive, multi-turn exchange the operator drives with a Harness in a
Working Directory over ACP — a sibling to Task, not a variant of it. Unlike
a Task it is never queued, never picked by the Auto-Runner, and never enters
the review gate; the human is in the loop for every turn. "Chat" is the
informal UI verb ("open a chat"); the domain noun is Conversation.
It is **active** while its harness process is warm (spawned on the first
turn, kept alive across widget/socket close) and **ended** once explicitly
ended, idle past the timeout, or killed by a server restart — an ended
Conversation survives as read-only history but cannot resume.
_Avoid_: chat (as the noun), session (ACP-overloaded), thread

**Turn**:
One operator message and the Harness's response to it within a Conversation
— the interactive analogue of a Run's single prompt turn. A Conversation is
a sequence of Turns against one long-lived ACP session.
_Avoid_: message (ambiguous — a Turn contains many ACP message chunks)

**Permission Rule**:
An operator-visible, revocable rule that auto-answers a Harness's
`session/request_permission` in a Conversation without prompting the human.
Matches on tool **kind** (read / edit / execute / fetch) + Working
Directory. Persistent rules are a deliberate opt-in ("Always allow in
{dir}") — the interactive default is per-turn ("Allow once") or
per-Conversation (native ACP `allow_always`, which dies with the
Conversation and writes no rule).
_Avoid_: allowlist, policy

### Lifecycle

**draft**: Being authored; never picked up for execution.

**blocked**: Has at least one Dependency not yet completed. Becomes *ready*
automatically when the last one completes.

**ready**: Eligible for execution, manually or by the Auto-Runner.

**running**: A Harness is currently executing a Run for it.

**awaiting-review**: The Run finished; a reviewer must Accept or Reject.

**completed**: Terminal. The result was accepted; only this state satisfies
dependents.

**failed**: The Run errored, was interrupted by a restart, or the result was
rejected. Re-queueable to *ready*, optionally with feedback.

**cancelled**: Terminal. Abandoned deliberately.

**Accept / Reject**:
The review decision on an *awaiting-review* Task. Accept completes it (and
in worktree mode merges the Run's branch into its base branch; a conflict
returns it to *awaiting-review*). Reject fails it. Human-only unless the
agent-review config flag is enabled.
_Avoid_: approve, merge (as the verb for the decision)

### Execution

**Harness**:
An agent CLI that Harmonic drives to execute Runs — Claude (Claude Code),
Codex, or Copilot — exclusively over ACP.
_Avoid_: agent (ambiguous), backend, provider

**Working Directory**:
The directory where a Task's Runs execute — its Workspace's directory,
snapshotted onto the Task at creation so a finished Run's record never shifts
if the Workspace is later renamed, repointed, or deleted.
_Avoid_: cwd, project dir

**Isolation Mode**:
How a Run touches its Working Directory — **direct** (in place, unlocked;
concurrent collisions are the operator's problem) or **worktree** (a
temporary git worktree on branch `harmonic/task-<id>-run-<n>` off the base
branch; the branch remains as the artifact). Workspace default, per-Task
override.

**Auto-Runner**:
The single scheduler across all Workspaces. When a Workspace has it enabled,
starts that Workspace's *ready* Tasks — highest Priority first, FIFO within —
up to the Workspace's own concurrency cap, never exceeding the Machine
Ceiling in total.
_Avoid_: daemon, worker pool

**Usage**:
Token counts and tool-call tallies for a Run or Conversation, parsed
continuously from the Harness's native session logs — the parent session plus
every Subagent session — while it executes, rolled up so the parent's total
includes its whole Process Tree. Persisted as a single latest snapshot during
execution and finalised at the end; the source for Cost and statistics.

**Subagent**:
A nested agent a Harness spawns within a Run or Conversation — itself a
token-spending session with its own model and Usage. Discovered from the
Harness's native logs; its Usage rolls up into the parent's. Claude and
Copilot spawn them; Codex does not.
_Avoid_: helper, child task

**Process Tree**:
A root process (a Run or Conversation) and its recursive Subagents — each a
node with its own model, Usage, context fill, and live status (active →
inactive → hidden as idle age grows, reactivating on new writes). Derived
per-Harness at read time; never stored as a structure.
_Avoid_: call graph

**Harness Adapter**:
The per-Harness code module behind which all harness-specific knowledge
lives: spawn tweaks (quirk workarounds), the model pin — spawn-time env
(Claude, Codex) or ACP `session/set_model` after `session/new` (Copilot) —
and the Usage Collector. Keyed by Harness; operator config holds only
what is genuinely operator-tunable.
_Avoid_: plugin, driver

**Usage Collector**:
The per-Harness mechanism that parses the Harness's native session logs into
Usage and the Process Tree — a per-model token breakdown across the parent and
every Subagent session. Claude and Codex read jsonl transcripts; Copilot reads
its session store. Each Harness has exactly one. ACP result metadata and OTel
are no longer the source (see ADR 0009).
_Avoid_: log parser (it is more than one log)

**Cost**:
The API-equivalent dollar value of Usage: token counts priced per model,
always derived from Usage on demand, never stored. A Task's Cost sums all
its Runs, retries included. A model without a configured price yields no
Cost, and any aggregate containing it is flagged incomplete — never a fake
zero. A Run's Cost includes its Subagents' tokens (its whole Process Tree).
Harness-native spend units (e.g. Copilot AI Units) are never folded into Cost.
_Avoid_: spend, billing (it is an estimate, not an invoice)

**AI Unit**:
Copilot's native consumption unit (~$1 each), read per-turn from Copilot's
session store (with Subagent attribution). Recorded on Usage and shown as
actual spend alongside Cost — a separate figure, not a Cost input.

### Interfaces

**Activity**:
The instance-wide live view of every in-flight harness process — Runs and
active Conversations across all Workspaces — showing realtime Usage, context
fill, Cost, and each process's Process Tree. Read-only but for a per-process
Stop/Kill and a deep-link to a related ticket; holds no state of its own.
_Avoid_: monitor, dashboard

**Notification Channel**:
A configured destination — Discord webhook, Slack webhook, Generic webhook,
or Email — subscribed to a set of event types, overridable per Task.

**API Key**:
A named, revocable bearer token for the REST API and MCP server, created
and managed by the operator. Full scope by default (drives the whole fleet);
a **read** scope mints a read-only variant. Listing keys shows both — never
the ephemeral Run/Conversation Keys.
_Avoid_: token (ambiguous with Run Key)

**Read Key**:
A read-scoped API Key for a viz client: it may GET tasks, runs, and Maps and
open the firehose WebSocket (filtered to task/run/run-event — no Conversation
or permission traffic), but every mutation and the operator surface (keys,
config, channels, Conversations) is blocked. Operator-created and listed like
a full API Key, unlike the ephemeral Run/Conversation Keys.
_Avoid_: viz key, guest key

**Run Key**:
An ephemeral bearer token Harmonic mints per Run and injects into the
spawned Harness so agents reach MCP without setup. Deleted outright when
the Run finishes (a startup sweep removes orphans); never listed or shown
in the UI.
_Avoid_: scoped key, per-run API key

**Conversation Key**:
The Conversation analogue of a Run Key — an ephemeral bearer token minted
per Conversation and injected into its Harness (same `HARMONIC_API_KEY` /
`HARMONIC_MCP_URL` mechanism) so the chatting agent can reach MCP (e.g.
create Tasks mid-conversation). Deleted when the Conversation ends; the
startup sweep removes orphans. Never listed or shown.
