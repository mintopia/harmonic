# Harmonic

A web application running inside a Coder workspace that executes autonomous
agent Tasks by driving agent Harnesses over ACP.

## Language

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
The directory where a Task's Runs execute; per-Task, defaulting from global
configuration.
_Avoid_: cwd, project dir

**Isolation Mode**:
How a Run touches its Working Directory — **direct** (in place, unlocked;
concurrent collisions are the operator's problem) or **worktree** (a
temporary git worktree on branch `harmonic/task-<id>-run-<n>` off the base
branch; the branch remains as the artifact). Global default, per-Task
override.

**Auto-Runner**:
The scheduler. When enabled, starts *ready* Tasks — highest Priority first,
FIFO within — up to a configured maximum of concurrent Runs.
_Avoid_: daemon, worker pool

**Usage**:
Token counts and tool-call tallies for a Run, collected from ACP extension
metadata or the Harness's native session log; aggregated for statistics.

**Harness Adapter**:
The per-Harness code module behind which all harness-specific knowledge
lives: spawn tweaks (quirk workarounds), the model pin — spawn-time env
(Claude, Codex) or ACP `session/set_model` after `session/new` (Copilot) —
and the Usage Collector. Keyed by Harness; operator config holds only
what is genuinely operator-tunable.
_Avoid_: plugin, driver

**Usage Collector**:
The per-Harness mechanism that produces Usage for a Run: ACP-reported
totals plus, where the Harness exposes one (native session log or ACP
result metadata), a per-model breakdown. Each Harness has exactly one.
_Avoid_: log parser (it is more than the log)

**Cost**:
The API-equivalent dollar value of Usage: token counts priced per model,
always derived from Usage on demand, never stored. A Task's Cost sums all
its Runs, retries included. A model without a configured price yields no
Cost, and any aggregate containing it is flagged incomplete — never a fake
zero. Harness-native spend units (e.g. Copilot AI Units) are never folded
into Cost.
_Avoid_: spend, billing (it is an estimate, not an invoice)

**AI Unit**:
Copilot's native consumption unit (~$1 each). When observable per Run it
is recorded on Usage and shown as actual spend alongside Cost — a
separate figure, not a Cost input.

### Interfaces

**Notification Channel**:
A configured destination — Discord webhook, Slack webhook, Generic webhook,
or Email — subscribed to a set of event types, overridable per Task.

**API Key**:
A named, revocable bearer token for the REST API and MCP server, created
and managed by the operator. Listing keys shows only these.
_Avoid_: token (ambiguous with Run Key)

**Run Key**:
An ephemeral bearer token Harmonic mints per Run and injects into the
spawned Harness so agents reach MCP without setup. Deleted outright when
the Run finishes (a startup sweep removes orphans); never listed or shown
in the UI.
_Avoid_: scoped key, per-run API key
