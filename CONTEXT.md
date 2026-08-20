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

**Setting Override**:
An overridable setting — Task defaults (Harness, model, Isolation Mode,
Priority) and a Workspace's concurrency cap — resolves as `Workspace value ??
global default`: a Workspace stores *inherit* (tracking the global default as
it changes) until it sets an explicit value, which a *reset to default*
clears back to inherit. Global-only settings (Harnesses, prices, Notification
Channels, Permission Rules, API Keys, the Drive Prompt, the Machine Ceiling)
have no Workspace form; Workspace-only settings (name, Working Directory,
Tracker enable/interval, Auto-Runner enable) have no global form.
_Avoid_: setting, config value

### Tasks

**Task**:
A unit of autonomous work — a prompt plus execution settings (Harness,
model, Working Directory, Isolation Mode) that moves through a lifecycle.
_Avoid_: job, ticket, item

**Run**:
One execution attempt of a Task by a Harness that settles to one reviewable
result, owning its event stream, Usage, and result. A retry is a new Run —
reusing the prior Session while its cache is warm, else a fresh Session that
references the prior work.
_Avoid_: execution, attempt, session (a Run runs *against* a Session; they are
not the same — see Session)

**Phase**:
Where a Run sits in its lifecycle: `executing → validating → verifying →
[review] → landing → terminal`, persisted on the Run and branching once — a
human-gated native Run passes through **review**, a mirrored / auto-accept Run
skips it. Distinct from the Run's *state* (the terminal RunState): a native Run
is `state:'running'` while **parked** in `phase:'review'` awaiting the human
gate. Agent-finish begins **validating**, it does not settle the Run.
_Avoid_: stage, step, status (a Phase is not the Run's terminal state)

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

**Delete**:
Permanently remove a Task, along with its Runs, Usage, and Dependency edges — distinct from Cancel, which keeps the record. Allowed only when the Task is not running. A native Task is removed outright; a mirrored Task is Dismissed (see below) so a re-poll cannot resurrect it. Its former dependents are re-derived (blocked → ready). Governed by ADR-0025.
_Avoid_: cancel (Cancel keeps the record; Delete removes it).

### Task id vs tracker ref

**Task id**:
The database primary key of a Task — what `finish_task` / `escalate_task` take as `taskId` and `GET /api/tasks/:id` uses. Rendered `T-<id>` in compact identifier slots (Deck row, graph node, table cell) and `Task <id>` in prose and dialog titles, never a bare `#`. The formatter lives in `web/src/id-format.ts`.

**Tracker ref**:
The GitHub issue number a mirrored Task resolves — e.g. `#185`. Rendered `#<ref>`, distinct from task id (issue #192). It is what `/implement <N>` takes as the argument. Where both appear on the Ticket header, both show disambiguated: `Task 174 · issue #185`.

### Tracker mirroring

**Resolved Tracker**:
Which issue tracker a Workspace's repo declares — **GitHub**, **GitLab**, or
**Local Markdown** — resolved from its `docs/agents/issue-tracker.md` at poll
time, never auto-detected. Surfaced read-only on the Workspace so the operator
can see what will be mirrored, or why nothing can be (no declaration, an
unsupported name). A resolution failure stops the poll loop from starting
rather than erroring every cycle.
_Avoid_: detected tracker, tracker type, provider

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

**Dismiss**:
Deleting a mirrored Task: the row and its Runs/Usage/edges are removed AND a tombstone on (Workspace, tracker ref) is written to the `tracker_dismissals` table so the poller stops re-mirroring that issue. The operator's way to say "stop mirroring this issue here." The tracker issue itself is untouched. Governed by ADR-0025 (issue #162).
_Avoid_: cancel, delete (Dismiss is specifically the mirrored-Task delete that tombstones the ref).

**Epic**:
A parent tracker issue that groups typed child tickets — the derived unit a
batch of related work shares. Two kinds: a **Map** (wayfinding children) and a
**Spec** (implementation children); both are Epics, differing only in what they
contain. **Derived, never authored** — Harmonic reads whatever parent/child
structure the tracker holds (native sub-issues, or a body task-list / `Part of
#<n>` line) and copes; setting the tickets up is the operator's or an agent's
job. Not a Task and not a stored entity — a query-time roll-up over the polled
tracker. The **leaf-most** Epic — the immediate parent of implementation Tasks —
is the unit its children are scheduled and landed as a group by. An Epic is a
**container**: it neither **blocks** its children (a `Blocked by: #<epic>` edge
is never projected — an Epic contains, it does not gate) nor **runs** (its drive
is forced *hitl*, so the Auto-Runner never executes the container itself).
_Avoid_: effort, project, batch, tranche, convoy

**Map**:
A kind of Epic: the mirror of a `wayfinder:map` issue, whose children are
wayfinding tickets (see Wayfinder Type). Charts a course via the wayfinder
skill; identified by its `wayfinder:map` label. Its members are the mirrored
Tasks that share its `mapRef`.
_Avoid_: effort, project (a Map is one *kind* of Epic, not a synonym for Epic)

**Spec**:
A kind of Epic produced by `/to-spec`: a parent ticket with a spec-shaped body
(problem / solution / acceptance) whose children are implementation Tasks.
Unlike a Map it carries **no label of its own** — it is identified structurally,
by having children and a spec body, not by a marker. Specs can nest (a spine
Spec whose children are themselves Specs); the leaf-most one owns the
implementation Tasks.
_Avoid_: epic (a Spec is one kind of Epic), story, ticket

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
runs it). Stored, and **re-synced from the ticket's labels on every re-poll**
(ready-for-human / grilling / prototype / bare-task → hitl; ready-for-agent /
research → afk; an **unclear** signal → *afk*, attempt optimistically), so
relabeling a mirrored issue flips its drive — **except while the Task is
escalated**, where Harmonic's runtime afk→hitl flip is preserved (a stale
ready-for-agent label must not undo it). The Auto-Runner's
whole predicate: pick-eligible iff `drive ≠ hitl`. Mirrored Tasks bypass the
review gate entirely — closure is a tracker act (the agent via its skill, or a
human), never an Accept/Reject. A clean Run is not success: the agent-via-skill
**closing the ticket** is the success signal (ADR 0011). A Run that ends without
closing it is *unresolved* — Auto-Retried then Escalated, its branch never
merged — never silently completed.
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
What becomes of a worktree Run's branch when an afk mirrored Task is resolved
(the agent closed its ticket) — **auto-merge** (default: merge into base once
resolved; a conflict Escalates rather than awaiting-review, which mirrored Tasks
lack),
**open-PR** (branch → GitHub PR, review off-Harmonic), or **artifact** (leave
the branch for a human/CI). Global default, per-Task override; worktree-only
(direct isolation has no branch). Research findings branches are always
artifacts regardless.
_Avoid_: merge policy

**Auto-Retry**:
On an afk Run failure (an error, the skill's own `/code-review` rejecting the
work, or a clean Run that left the ticket *unresolved*) Harmonic re-queues the
Task to *ready* as a fresh Run up to a
configurable max (default 1), still afk; exhausting the retries Escalates to
hitl (Run *failed*, drive→hitl, ticket open + un-assigned + flagged), never a
silent retry beyond the cap.
_Avoid_: auto-requeue

### Parallel Epic execution

**Integration branch**:
The per-Epic branch (`epic/<ref>`) Harmonic cuts off the default branch and
owns: every Member's worktree forks from it, every finished Member lands back
onto it, and it merges to the default branch in one atomic go once the whole
Epic is green — then Harmonic **retires** (deletes) it. Its mere existence is
the Epic's only persisted execution state.
_Avoid_: feature branch, epic branch

**Member**:
A direct child ticket of an Epic — one Member, one Task/Run — run concurrently
with its siblings, each in its own worktree cut from the Integration branch.
_Avoid_: child task, subtask

**Ready frontier**:
The subset of an Epic's Members currently runnable — *open*, unassigned, and
free of any open non-Epic blocker — recomputed every poll; the true width of
parallelism, not the whole Epic at once. Informally a **wave**: the next wave is
the frontier re-derived after blockers clear. Never a stored or numbered entity.
_Avoid_: wave (as a stored/numbered thing), batch

**Merge train**:
The single-writer, strict-FIFO mechanism that lands finished Members onto one
Integration branch one at a time — rebase onto the current tip, then
fast-forward — so landings never interleave and history stays linear. Different
Epics' branches land in parallel; only same-branch Members queue.
_Avoid_: merge queue, landing pipeline

**Heal (merge)**:
The one bounded corrective turn handed back to a conflicting Member's own warm
Session to resolve a rebase conflict, dispatched out-of-band so siblings aren't
stalled. A second conflict Escalates — there is no second Heal.
_Avoid_: retry, auto-resolve

**Member land status**:
Where a Member sits from the Epic's view — **pending** (running / not started /
awaiting review), **completed** (its work is folded into the Integration
branch), or **blocked** (escalated / failed / cancelled — a Blocking Member that
holds the whole Epic back). Mid-landing a Member may also read **healing** (a
corrective turn) or **escalated**.
_Avoid_: merge status

**Blocking member**:
A Member whose land status is *blocked* that stalls the whole Epic on the
automatic path until it clears or the operator Force-lands.
_Avoid_: stuck task

**Whole-Epic Verification**:
The Verification run against the Integration branch tip once the land gate
opens — the same command primitive as per-Run Verification — catching breakage
in the union of Members that each passed alone. A non-pass fail-safe Escalates;
Verification never self-heals at Epic scope.
_Avoid_: final check

**Whole-Epic land**:
Merging the Integration branch into the default branch in one atomic go and
retiring the branch — only when the land gate is open and Whole-Epic
Verification passes.
_Avoid_: final merge

**Force-land the ready subset**:
The operator-only override that opens an Epic's land gate unconditionally —
landing whatever Members are already folded into the Integration branch even
while a sibling is stuck — without bypassing Whole-Epic Verification. The one
escape hatch when a Blocking Member stalls the Epic.
_Avoid_: force merge, partial land

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
returns it to *awaiting-review*). Reject fails it and, within the cache window,
its fix continues in the same Session. Human-only unless a Verification agent is
configured to auto-accept on a *pass*.
_Avoid_: approve, merge (as the verb for the decision)

### Execution

**Harness**:
An agent CLI that Harmonic drives to execute Runs — Claude (Claude Code),
Codex, or Copilot — exclusively over ACP.
_Avoid_: agent (ambiguous), backend, provider

**Session**:
One ACP conversation with a Harness — 1:1 with the harness's own session
(`sessionId`), the unit a Run or Conversation prompts over `session/prompt`, and
a durable first-class resource. A Session outlives a single Run: a retry, an
automated or human rejection, or a crash-recovery continue in the **same**
Session — reloaded into a fresh harness process via `session/load` (supported by
all three harnesses) as a **new Run and new prompt turn**, never by reattaching a
dead process. Reuse is always valid; the provider prompt-cache being warm only
makes the resumed turn **cheaper** — it is a cost signal, not a correctness gate.
The warm window is a per-Harness **cost estimate** (Claude ~1 h on a subscription
via `ENABLE_PROMPT_CACHING_1H`; others shorter), never a promise: Harmonic
records `lastActiveAt` and an estimated warm-until, and frames reuse as
full-context vs a condensed new Session by cost, not a hard TTL cutoff.
A Session moves `active → idle → retiring → retired`, and **Session retirement
is the sole owner of builder-worktree removal**: a worktree Session's checkout is
retained through the human-rejection window (so a reject-and-continue lands in the
same workspace) and removed only when the Session retires — on a successful land,
a reject-continuation timeout, a review-abandonment SLA, an operator disposition,
or a retention-TTL backstop — coordinated with the Work Context lease.
_Avoid_: thread, chat (the interactive sibling is a Conversation)

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
Ceiling in total. A global **master switch** gates all of them: a Task runs
only when the master is on *and* its Workspace has the Auto-Runner enabled, so
the master is the one-click fleet-wide pause. It also honours the Work Context
House Rule: it will not start an afk Run into a Work Context already occupied by
an afk Run that is running or awaiting verification/review.
_Avoid_: daemon, worker pool

**Guardrail**:
A limit Harmonic enforces over a *running* Run that, when it **trips**, stops
the Run and Escalates it with a short reason — the runtime's own authority to
end a Run it is watching, alongside the agent's own signals (`finish_task` /
`escalate_task`), process death, and operator action. Resolves as a global
default with a per-Workspace override (per-Task deferred); invisible until it
trips, when the reason surfaces on the card in the same slot as the escalated
tag. Members being designed: a **budget** Guardrail on elapsed time, token
count, or cost, a **progress** Guardrail against a stalled or looping agent,
and a
**branch-contract** Guardrail that the agent left branch and worktree
management to Harmonic.
_Avoid_: limit, timeout, watchdog, quota

**Work Context**:
The (Working Directory + branch) an automatic Run occupies — in *direct* mode
the shared directory on its live branch, in *worktree* mode the Run's own
worktree and branch. The unit of the **House Rule**: at most **one automatic
(afk) Run per Work Context** may be running or awaiting verification/review at
once, so unreviewed work is never stacked on top of. Enforced by the
Auto-Runner as a pick predicate.
_Avoid_: workspace (that is the board container), sandbox

**Verification**:
An automated check that gates a Run's result before it merges or reaches the
human review gate — a **command** (the Workspace's test/lint), an **agent** (a
critic Harness with its own configurable prompt and model), or both; resolved
global default with a per-Workspace override. Its verdict is **pass / fail /
inconclusive**; *inconclusive* fails safe (Escalate, never a silent pass). A
fail drives a bounded self-heal — the agent fixes it in the **same Session** —
before Escalating. The agent verifier **replaces** the older agent-review flag:
its *pass* is what auto-accepts where configured.
_Avoid_: review (that is the human Accept/Reject gate), lint, test (it is more
than either)

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

**Dependency Graph**:
A read-only, per-Workspace view (rail label **Graph**) that lays out the
board's Tasks as a directed acyclic graph over their Dependency edges — native
and mirrored alike. Active-state Tasks by default, terminal ones behind a
toggle; Tasks sharing a Map are positioned together, not boxed. A node
deep-links to its Task; edits happen in Task detail, never on the graph.
_Avoid_: DAG view, tree, board graph

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
open the firehose WebSocket (filtered to task/run/run-event/run-usage — no
Conversation or permission traffic), but every mutation and the operator surface (keys,
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
