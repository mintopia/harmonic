# Harmonic

A web application running inside a Coder workspace that executes autonomous
agent Tickets by driving agent Harnesses over ACP.

## Language

### Workspaces

**Workspace**:
A named Working Directory (a repo root), unique by absolute path — the
container for a board of Tasks and Conversations bound to that directory,
its own execution settings (Task defaults, Auto-Runner, Tracker, Drive), and
its own Tracker poll loop. One Harmonic instance hosts many; there is always
at least one, and the last cannot be deleted. Deleting one is guarded (no
in-flight work) and cascades to its Tasks, Attempts, and Conversations.
_Avoid_: project, repo, context

**Machine Ceiling**:
The global cap on total concurrent Attempts across all Workspaces — the machine's
safety limit that a Workspace's own concurrency cap can never breach.

**Setting Override**:
An overridable setting resolves through three layers — **Baseline** (shipped
defaults) → **Global** (the operator's sparse patch over baseline) →
**Workspace** (a sparse patch over the resolved global): `Workspace value ??
merge(Baseline, Global patch)` at read time. Each layer stores only what it
changes; an untouched field renders **muted** and *tracks the layer beneath it*
as that layer ships new defaults, while an overriding value renders unmuted with
a *modified* mark and a *revert* control — per-field, plus a top-level revert to
distributed. Global-only settings (Harnesses and their Model catalogs,
Notification Channels, Permission Rules, API Keys, the Drive Prompt, the Machine
Ceiling) have no Workspace form; Workspace-only settings (name, Working
Directory, Tracker enable/interval, Auto-Runner enable) have no global form. The
baseline is a shipped `baseline.yaml`; the operator + Workspace patches live in
`settings.yaml` (ADR-0009, ADR-0022).
_Avoid_: setting, config value

**Baseline** (adjective: **distributed**):
The bottom configuration layer — the defaults Harmonic *ships*, held in an
in-repo `baseline.yaml` validated at boot, the single source of every default
(so a default with no baseline home — a **magic string** — is a defect). The
Global layer is a sparse patch merged onto it; **revert to distributed** drops
that patch, and a field is **Modified** exactly when it differs from the layer
beneath it. Collections in the patch (a Harness's Model catalog, price/context
overrides) **merge by id** — add, per-field override, or *tombstone* an entry —
so untouched entries keep tracking baseline additions. (ADR-0022.)
_Avoid_: default config, factory settings, seed (it is the shipped baseline, not
a one-time seed)

### Tickets

**Task** (synonym: **Ticket**):
The board unit of autonomous work — a prompt plus execution settings (Harness,
model, Working Directory, Isolation Mode) that moves through the lifecycle,
native or mirrored. One concept, two names: "Ticket" is its tracker-facing
flavour, and both are used interchangeably. The Task owns its branch and
worktree, and is worked in that one branch by a loop of Attempts. Governed by
ADR-0001.
_Avoid_: job, item, run (deleted concept)

**Attempt**:
One iteration of a Task's implement→verify loop, and the single execution
noun: it carries the Session it prompts over, Usage, Cost, guardrail scoping,
the transcript locator, and its timeline of Steps (Implementation →
Verification per command → Review), ending at a verdict. A failed verdict —
command fail, review reject, or review `inconclusive` — feeds the next
Attempt in the same worktree (counter +1); `maxAttempts` reached →
*escalated*. The Attempt is the history unit on the Ticket page; a
commit-your-work nudge increments nothing. The system never creates a new
Ticket in response to failure. Crash recovery reasons about Attempts
directly.
_Avoid_: retry, reattempt (old loop mechanisms collapsed into this counter);
run, phase, candidate, self-heal (all deleted concepts, ADR-0001)

**Step**:
One individually undertaken step within an Attempt, each a timeline row with
its own logs and outcome: the **Implementation Step** (the agent implements
and commits — only the agent ever commits), one **Verification Step** per
configured command (ordered, fail-fast), and the optional **Review Step**
(the critic). There is no rebase step — base movement is reconciled by the
merge commit, never by re-basing the work (ADR-0001).
_Avoid_: task (the board unit), run, phase, stage

**Activity Event**:
One ACP `session/update` (message chunk, thought, tool call, plan update)
rendered in the Activity/transcript views. The stream is **not persisted**:
it is parsed on demand from the harness's native transcript via the persisted
locator; the DB keeps only tool-call aggregates and small structured facts
(ADR-0007).
_Avoid_: log line, message, run event (pre-reset name)

**Fact**:
A small, immutable recorded signal an Attempt emits (agent-finish, verdicts,
guardrail trips, lifecycle transitions) that routing derives from: every
lifecycle transition is a deterministic function of recorded Facts — agent
judgment lives inside the Implementation and Review Steps, never in routing.
_Avoid_: event (that is the Activity Event stream), log line, marker

**Blocker**:
A directed edge between Tickets, stored one-to-many: the dependent is
ineligible for pickup while it has any open Blocker. Native dependencies and
mirrored tracker blocked-by relations are both written as the same edges.
Blocked-ness is always **derived** from the open-Blocker count — never a
stored state — so it cannot go stale.
_Avoid_: dependency, prerequisite, parent

**Priority**:
A per-Ticket rank (high / normal / low) used only by the Auto-Runner's pick
order; ties break FIFO by creation time.

**Delete**:
Permanently remove a Task, along with its Attempts, Usage, and Dependency edges — distinct from Cancel, which keeps the record. Allowed only when the Task is not running. A native Task is removed outright; a mirrored Task is Dismissed (see below) so a re-poll cannot resurrect it. Its former dependents are re-derived (blocked → ready). Governed by ADR-0004.
_Avoid_: cancel (Cancel keeps the record; Delete removes it).

### Task id vs tracker ref

**Task id**:
The database primary key of a Task — what `finish_task` / `escalate_task` take as `taskId` and `GET /api/tasks/:id` uses. Rendered `T-<id>` in compact identifier slots (board row, graph node, table cell) and `Task <id>` in prose and dialog titles, never a bare `#`. The formatter lives in `web/src/id-format.ts`.

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
owns its execution state (Attempts, Usage) and writes only claim/close back. A
re-poll upserts it. Never enters *draft* — a tracker issue is already
authored. Follows the same lifecycle as a native Ticket; tracker writes are
output side-effects, never a control path (see Agent-workable).
_Avoid_: imported task, synced issue

**Dismiss**:
Deleting a mirrored Task: the row and its Attempts/Usage/edges are removed AND a tombstone on (Workspace, tracker ref) is written to the `tracker_dismissals` table so the poller stops re-mirroring that issue. The operator's way to say "stop mirroring this issue here." The tracker issue itself is untouched. Governed by ADR-0004 (issue #162).
_Avoid_: cancel, delete (Dismiss is specifically the mirrored-Task delete that tombstones the ref).

**Epic**:
A parent tracker issue that groups typed child tickets — the unit a batch of
related work shares. **Three kinds**: a **Map** (wayfinding children), a **Spec**
(implementation children with a spec-shaped body), and a **plain Epic** (a bare
parent/child grouping, neither Map nor Spec). Harmonic does not author Epics — it
reads whatever parent/child structure the tracker holds (native sub-issues, or a
body task-list / `Part of #<n>` line) and copes; setting the tickets up is the
operator's or an agent's job. The **leaf-most** Epic — the immediate parent of
implementation Tasks — is the unit its children are scheduled and merged as a
group by, and it is a **first-class stored resource** (ADR-0018): a durable
record — its `kind`, integration merge-commit, lifecycle state, and a member-ref
snapshot — that outlives the tracker issue closing, so historical Epics and the
whole-Epic diff resolve without re-derivation. It was formerly a query-time
roll-up (ADR-0016, superseded). Parent/spine Epics above the leaf stay derived
roll-ups; membership and agent-workability stay derived. Every Epic cuts an
`epic/<ref>` integration branch; finishing merges it to base (a **no-op** when
branch and base already match) and **closes the tracker issue**. An Epic is a
**container**: it neither **blocks** its children (a `Blocked by: #<epic>` edge
is never projected — an Epic contains, it does not gate) nor **runs** (it is
never agent-workable, so the Auto-Runner never executes the container itself).
_Avoid_: effort, project, batch, tranche, convoy

**Map**:
A kind of Epic: the mirror of a `wayfinder:map` issue, whose children are
wayfinding tickets (see Wayfinder Type). Charts a course via the wayfinder
skill; identified by its `wayfinder:map` label. Its members are the mirrored
Tasks that share its `mapRef`. Alone among the kinds, a Map's children drive
**`/wayfinder {mapRef}`** — each child's session advances the map, pointed at
the map's issue id, not the child's own; Spec and plain-Epic children drive
`/implement {ref}`.
_Avoid_: effort, project (a Map is one *kind* of Epic, not a synonym for Epic)

**Spec**:
A kind of Epic produced by `/to-spec`: a parent ticket with a spec-shaped body
(problem / solution / acceptance) whose children are implementation Tasks.
Unlike a Map it carries **no label of its own** — it is identified structurally,
by having children and a spec body, not by a marker. Specs can nest (a spine
Spec whose children are themselves Specs); the leaf-most one owns the
implementation Tasks. A parent/child grouping with **no** spec body and no map
label is a **plain Epic**, not a Spec — the two differ only by the spec body and
drive their children identically (`/implement`).
_Avoid_: story, ticket

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

**Agent-workable**:
The derived flag that makes a Ticket eligible for pickup: `ready-for-agent`
present (the positive opt-in gate, re-synced from labels on every re-poll,
issue #230) AND no open Blockers. Never stored. **HITL is not in Harmonic**:
a mirrored issue without the label is a human-only Ticket — it stays visible
on the board (it may block others; rendered muted with a distinct HITL icon)
but takes no actions and is updated only by mirroring until the tracker
closes it. Assignment is never consulted. Ticket closure is a tracker act,
mirrored in as an **output side-effect, never a control path** (ADR-0004): success is the verification
verdict plus merge.
_Avoid_: drive, afk, hitl (as stored modes — all deleted), mode, assignee

**Escalation**:
The *escalated* state and the single human surface (ADR-0002). A Ticket
reaches it only via: (1) attempt counter exhausted, (2) a guardrail trip
(branch-contract included), (3) permanent infrastructure failure, (4) an
unresolved merge conflict after the bounded resolve turns, (5) a red
post-merge check (its revert recorded on the timeline). Exactly three
actions there: **Reject with guidance** (guidance becomes feedback, counter
resets, the Ticket **requeues** to *ready* — capacity picks it up, or the
warm-Session "start now" override starts it immediately), **Accept** (counts
as success; the normal merge/close/cleanup path continues), **Close** (closes
the Ticket and cleans up: branch, worktree, tracker issue). Escalated Epics
surface in the same attention section.
_Avoid_: downgrade, fallback, handoff, adopt / note-to-critic / un-escalate
(deleted escape hatches)

**Drive Prompt**:
The prompt Harmonic injects to auto-run a mirrored Ticket: a settings
template (global default, per-Workspace override — ADR-0009) of a workflow
slash-command plus a short preamble, filled from the Task — `{skill}` from
its Workflow / Wayfinder Type (research→`/research`,
implement→`/implement`), plus `{ref}` `{url}` `{title}` `{body}`. The
preamble tells the agent to resolve the ticket end-to-end and comment +
close it via the tracker doc's `gh` mechanics; the skills stay the source of
truth. The Attempt then streams Activity Events like any other — no separate
visibility path.
_Avoid_: injected command, auto-prompt

**Merge Fate**:
What becomes of a worktree Task's branch when its Attempt passes
verification — **auto-merge** (default: the one merge policy of ADR-0001 —
merge commit under the mutex, post-merge check, revert on red), **open-PR**
(branch → GitHub PR, review off-Harmonic), or **artifact** (leave the branch
for a human/CI). Global default, per-Task override; worktree-only (direct
isolation has no separate branch). Research findings branches are always
artifacts regardless.
_Avoid_: merge policy (that is ADR-0001's one policy; the Fate picks whether
it applies)

**Max Attempts**:
The configured bound on a Ticket's Attempt loop (global default, per-Workspace
override). Exhausting it is escalation trigger (1) — never a silent retry
beyond the cap, never a new Ticket. Replaces every earlier loop mechanism
(Auto-Retry, reattempt, self-heal budgets).
_Avoid_: auto-retry, retry cap

### Parallel Epic execution

**Integration branch**:
The per-Epic branch (`epic/<ref>`) Harmonic cuts off the default branch and
owns: every Member's worktree forks from it, every finished Member merges back
onto it, and it merges to the default branch in one atomic go once the whole
Epic is green — then Harmonic **retires** (deletes) it. Its mere existence is
the Epic's only persisted execution state.
_Avoid_: feature branch, epic branch

**Refresh**:
Keeping an Integration branch fresh: whenever the default branch advances,
merge it **into** each live Integration branch (merge, never rebase — Member
worktrees fork off it and a rebase would rewrite history under them), under
the same merge mutex as every other merge. A refresh conflict gets one
bounded agent merge-resolution turn; a refresh that cannot complete is
**recorded quietly and retried on the next trigger, never raised as an
operator hold** (ADR-0001). "Rebase" is not used anywhere in the model.
_Avoid_: sync, catch-up merge

**Member**:
A direct child ticket of an Epic — an ordinary Task run concurrently with its
siblings, its per-Task worktree cut from the Integration branch.
_Avoid_: child task, subtask

**Ready frontier**:
The subset of an Epic's Members currently runnable — **agent-workable** (the
same derived flag, issue #230), *open*, and free of
any open non-Epic Blocker — recomputed every poll; the true width of
parallelism, not the whole Epic at once. Informally a **wave**: the next wave is
the frontier re-derived after blockers clear. Never a stored or numbered entity.
_Avoid_: wave (as a stored/numbered thing), batch

**Member merge status**:
Where a Member sits from the Epic's view — **pending** (working / not
started), **completed** (its work is merged into the Integration branch), or
**blocked** (escalated / cancelled — a Blocking Member that holds the whole
Epic back).
_Avoid_: merge status, merge train (deleted concept — Members merge by the
one merge policy under the mutex, ADR-0001)

**Blocking member**:
A Member whose merge status is *blocked* that stalls the whole Epic on the
automatic path until it clears or the operator Force-integrates.
_Avoid_: stuck task

**Whole-Epic Verification**:
The Verification run against the Integration branch tip once the integrate gate
opens — the same command primitive as per-Attempt Verification — catching breakage
in the union of Members that each passed alone. A non-pass fail-safe Escalates;
Verification runs no corrective turn at Epic scope.
_Avoid_: final check

**Whole-Epic integrate**:
Merging the Integration branch into the default branch — a merge commit under
the mutex, the post-merge check on the merged default tip, revert-and-escalate
on red (ADR-0001) — then retiring the branch. Runs only when the integrate
gate is open and Whole-Epic Verification passes; a cheap ancestor check first
keeps it idempotent when the work is already contained.
_Avoid_: final merge

**Force-integrate the ready subset**:
The operator-only override that opens an Epic's integrate gate unconditionally —
integrating whatever Members are already folded into the Integration branch even
while a sibling is stuck — without bypassing Whole-Epic Verification. The one
escape hatch when a Blocking Member stalls the Epic.
_Avoid_: force merge, partial integrate

### Conversations

**Conversation**:
An interactive, multi-turn exchange the operator drives with a Harness in a
Working Directory over ACP — a sibling to Task, not a variant of it. Unlike
a Task it is never queued, never picked by the Auto-Runner, and never verified
or merged; the human is in the loop for every turn. "Chat" is the
informal UI verb ("open a chat"); the domain noun is Conversation.
It is **active** while its harness process is warm (spawned on the first
turn, kept alive across widget/socket close) and **ended** once explicitly
ended, idle past the timeout, or killed by a server restart — an ended
Conversation survives as read-only history but cannot resume.
_Avoid_: chat (as the noun), session (ACP-overloaded), thread

**Turn**:
One operator message and the Harness's response to it within a Conversation
— the interactive analogue of an Attempt's prompt turn. A Conversation is
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

The stored Ticket states (ADR-0001). Blocked-ness and agent-workability are
**derived**, never stored (see Blocker, Agent-workable). There is no *failed*
state (failure is an Attempt-level Fact; a Ticket loops or escalates, and only
a human closes it) and no *awaiting-review* (the human gate is deleted).

**draft**: Being authored; never picked up for execution.

**ready**: Eligible for pickup once agent-workable, manually or by the
Auto-Runner.

**working**: The Attempt loop is executing — some Task of the current Attempt
is in flight, or the Ticket is merging.

**escalated**: Waiting on a human; see Escalation for the triggers and the
three actions.

**done**: Terminal. Verified, merged, and cleaned up; only this state
satisfies dependent Tickets.

**cancelled**: Terminal. Abandoned deliberately.

**Merge**:
The Ticket-level step after a passing verdict, one policy on every path
(ADR-0001): under an in-process mutex per Workspace repository, an ordinary merge commit of the ticket
branch — onto the Integration branch for an Epic Member, onto develop
otherwise — then the deterministic verify commands once on the merged base
tip. Green releases the mutex; red reverts the merge commit and escalates. A
textual conflict gets bounded agentic resolve-turns, then escalates. Base
movement since the verdict is irrelevant — the merge commit reconciles the
trees, and a verdict attaches to the Attempt, never to a SHA. There is no
freshness gate, no SHA assertion, and no re-verification loop.
_Avoid_: accept, merge gate, land (banned)

### Execution

**Harness**:
An agent CLI that Harmonic drives to execute Attempts — Claude (Claude Code),
Codex, Copilot, or OpenCode — exclusively over ACP. A **closed set of four**:
each needs a code Adapter, so operators tune a Harness's config (command, args,
env, its Model catalog) but cannot add a Harness. Each Harness owns a **Model
catalog** and a single **`cacheWarmSeconds`** — the warm-window estimate that
seeds a Session's derived warm-until. OpenCode runs unattended via its
`--auto` spawn flag (it has no full-access ACP mode to flip into), and is a
multi-**Provider** router whose catalog can be discovered at runtime (see
Harness Capability). (ADR-0025.)
_Avoid_: agent (ambiguous), backend, provider (a Provider is what a routing
Harness routes *to*, not a synonym for the Harness)

**Provider**:
An upstream model vendor or gateway a routing Harness can send a prompt to —
OpenRouter, Meta, OpenCode Zen, and so on — credentialed per-Provider. A Model
under a Provider is addressed `provider/model`. A Provider is **available** when
it is credentialed (plus any always-on free tier); only available Providers are
offered by discovery. Distinct from a Harness: OpenCode is one Harness that
routes across many Providers. (ADR-0025.)
_Avoid_: harness, backend, vendor (as a synonym for Harness)

**Harness Capability**:
An **optional** ability a Harness's Adapter declares beyond the base contract,
absent on the Harnesses that do not support it. The first two are **dynamic
discovery** — **select_provider** (the available Providers a Harness can route
to) and **select_model** (the Models available under a given Provider, with
price and context window). Only OpenCode declares them today; discovery reads
local metadata (the models.dev cache + credential file), costs no inference,
and surfaces in the launcher as a per-run Model pick that prices itself from
that metadata. (ADR-0025.)
_Avoid_: feature, plugin, extension

**Model**:
A first-class entry in a Harness's **Model catalog** —
`{ id, price, contextWindow }` — the unit a Task, Conversation, or Subagent
pins. Owned by its Harness, so the same id may carry a *different* price under a
different Harness (Copilot). The catalog is **open**: a custom id is a valid
entry with no price / context window, so its Cost is flagged *incomplete*, never
a fake zero. Selecting a different Harness **resets** the Model to that Harness's
default rather than carrying a stale value. Cache warmth is a Harness property
(`cacheWarmSeconds`), not the Model's. (ADR-0022.)
_Avoid_: model string, model name (a Model is a catalog entry, not a bare id)

**Session**:
One ACP conversation with a Harness — 1:1 with the harness's own session
(`sessionId`), the unit an Attempt or Conversation prompts over `session/prompt`, and
a durable first-class resource. A Session outlives a single Attempt: a retry, an
automated or human rejection, or a crash-recovery continue in the **same**
Session — reloaded into a fresh harness process via `session/load` (supported by
all three harnesses) as a **new Attempt and new prompt turn**, never by
reattaching a dead process. Reuse is always valid; the provider prompt-cache being warm only
makes the resumed turn **cheaper** — it is a cost signal, not a correctness gate.
The warm window is a per-Harness **cost estimate** — the Harness's
`cacheWarmSeconds` (Claude ~1 h on a subscription via `ENABLE_PROMPT_CACHING_1H`;
others shorter), never a promise: Harmonic
records `lastActiveAt` and an estimated warm-until, and frames reuse as
full-context vs a condensed new Session by cost, not a hard TTL cutoff.
A Session moves `active → idle → retiring → retired`. Builder-worktree removal
is owned by the **Task**, not the Session (ADR-0001):
the per-Task worktree is retained across Attempts and removed only at the
Task's terminal disposition (merged, or operator close/cancel).
_Avoid_: thread, chat (the interactive sibling is a Conversation)

**Working Directory**:
The directory where a Task's Attempts execute — its Workspace's directory,
snapshotted onto the Task at creation so a finished Attempt's record never
shifts if the Workspace is later renamed, repointed, or deleted.
_Avoid_: cwd, project dir

**Isolation Mode**:
How a Task's Attempts touch the Working Directory — **direct** (in place on
the base branch, no isolation machinery; the single checkout naturally
serialises to one worker) or **worktree** (one per-Task checkout on a stable
`harmonic/task-<id>` branch cut from the base, created at task start, reused
by every Attempt, removed at task done). Declared on the Task — never
inferred from branch shape. Workspace default, per-Task override.

**Auto-Runner**:
The single scheduler across all Workspaces. When a Workspace has it enabled,
starts that Workspace's *ready* Tasks — highest Priority first, FIFO within —
up to the Workspace's own concurrency cap, never exceeding the Machine
Ceiling in total. A global **master switch** gates all of them: a Task runs
only when the master is on *and* its Workspace has the Auto-Runner enabled, so
the master is the one-click fleet-wide pause. It also honours the Work Context
House Rule as a pick predicate: it will not start an Attempt into a Work
Context already occupied by a working Ticket.
_Avoid_: daemon, worker pool

**Guardrail**:
A limit Harmonic enforces over a *running* Attempt that, when it **trips**,
stops it and Escalates with a short reason — the runtime's own authority to
end work it is watching, alongside the agent's own signals (`finish_task` /
`escalate_task`), process death, and operator action. Resolves as a global
default with a per-Workspace override (per-Task deferred); invisible until it
trips, when the reason surfaces on the card in the same slot as the escalated
tag. Members (ADR-0002): a **budget** Guardrail on elapsed time, token count,
or cost (cost falls back to tokens on an unpriced model); a **progress**
Guardrail against a stalled or looping agent (one steer-channel nudge before
escalating); and the **branch-contract** Guardrail that the agent left branch
and worktree management to Harmonic, judged from the agent's own working
directory, never from watching refs.
_Avoid_: limit, timeout, watchdog, quota

**Work Context**:
The (Working Directory + branch) an automatic execution occupies — in *direct*
mode the shared directory on its live branch, in *worktree* mode the Task's own
worktree and branch. The unit of the **House Rule**: at most **one automatic
execution per Work Context** may be working at once, so unverified work is
never stacked on top of. Enforced by the Auto-Runner as a pick predicate
(ADR-0001) — a scheduler predicate, never a lease.
_Avoid_: workspace (that is the board container), sandbox

**Verification**:
The automated gate between implementation and Merge, run inside each
Attempt: `verify.commands[]` (ordered, fail-fast, one Verification Task each)
then the optional **Review Task** — a single critic Harness with configurable
harness, model, and prompt, run only after the commands pass. Resolved global
default with per-Workspace override; zero verifiers configured = the gate
passes. Any command fail, review reject, or review *inconclusive* is a
**failed Attempt** — feedback into the next Attempt, counter +1; `inconclusive`
burns an Attempt rather than escalating (ADR-0003). The verdict attaches to
the Attempt, never to a SHA (ADR-0001); Merge never re-checks it.
_Avoid_: review gate (deleted), validation, lint, test (it is more than either)

**Continuation rule**:
The deterministic choice at Attempt N+1: continue the prior Session (feedback
appended) iff its context usage is below `contextReuseThreshold` (config,
default 0.2) AND it is warm within a fixed per-Harness constant seeded from
known provider cache TTLs; otherwise a fresh Session seeded by the condensed
summary (issue #170 machinery) plus the feedback. The repo is the diff —
nothing else is passed.
_Avoid_: session reuse policy, cache gate

**Usage**:
Token counts and tool-call tallies for an Attempt or Conversation, parsed
continuously from the Harness's native session logs — the parent session plus
every Subagent session — while it executes, rolled up so the parent's total
includes its whole Process Tree. Persisted as a single latest snapshot during
execution and finalised at the end; the source for Cost and statistics.

**Agent**:
The root node of a Process Tree — the live harness Session driving an Attempt or
Conversation, with its own model, Usage, and context fill. Pairs with Subagent
(its spawned children); together they are the node terms the Activity view
shows. Distinct from the "avoid agent" note on Harness, which bars calling the
*CLI* an agent — an Agent is one running instance of a Harness, not the Harness.
_Avoid_: root process (fine inside Process-Tree internals; the UI term is Agent)

**Subagent**:
A nested agent a Harness spawns within an Attempt or Conversation — itself a
token-spending session with its own model and Usage. Discovered from the
Harness's native logs; its Usage rolls up into the parent's. Claude and
Copilot spawn them; Codex does not.
_Avoid_: helper, child task

**Process Tree**:
A root process (an Attempt or Conversation) and its recursive Subagents —
each a node with its own model, Usage, context fill, and live status (active
→ inactive → hidden as idle age grows, reactivating on new writes). Derived
per-Harness at read time; never stored as a structure.
_Avoid_: call graph

**Harness Adapter**:
The per-Harness code module behind which all harness-specific knowledge
lives: spawn tweaks (quirk workarounds), the model pin — spawn-time env
(Claude, Codex) or ACP `session/set_model` after `session/new` (Copilot) —
and the Usage Collector. Keyed by Harness; operator config holds only
what is genuinely operator-tunable. Carries an **optional** `capabilities`
extension point (see Harness Capability) that a Harness declares only if it
supports it. (ADR-0025.)
_Avoid_: plugin, driver

**Usage Collector**:
The per-Harness mechanism that parses the Harness's native session logs into
Usage and the Process Tree — a per-model token breakdown across the parent and
every Subagent session. Claude and Codex read jsonl transcripts; Copilot and
OpenCode read their SQLite session stores. Each Harness has exactly one. ACP result metadata and OTel
are no longer the source (see ADR 0009).
_Avoid_: log parser (it is more than one log)

**Cost**:
The API-equivalent dollar value of Usage: token counts priced per model. A
settled Attempt's Cost is computed once at settle against the price table
then in effect and **stored** — a later price edit never silently reprices
history (ADR-0008); live in-flight Cost is derived from the current snapshot.
A Task's Cost sums all its Attempts, retries included, each including its
Subagents' tokens (the whole Process Tree). A model without a configured
price yields no Cost, and any aggregate containing it is flagged incomplete
— never a fake zero. Harness-native spend units (e.g. Copilot AI Units) are
never folded into Cost.
_Avoid_: spend, billing (it is an estimate, not an invoice)

**AI Unit**:
Copilot's native consumption unit (~$1 each), read per-turn from Copilot's
session store (with Subagent attribution). Recorded on Usage and shown as
actual spend alongside Cost — a separate figure, not a Cost input.

**Event-loop guarantee**:
The promise that nothing — a slow query or a background loop — can freeze the
whole server (issue #200, ADR-0007). Harmonic runs synchronous SQLite on the
one Node event loop shared by every request, so a single blocking stretch stalls
*all* HTTP at once. Three defences hold the promise: an **Event-loop monitor**
(`src/reliability/event-loop-monitor.ts`) that probes loop delay and logs a
stall as a legible event; the **loops-must-yield** rule — any background loop or
heavy in-request scan that iterates many items hands the loop back on a
wall-clock budget via `forEachYielding` / `yieldToEventLoop`
(`src/reliability/yield.ts`) rather than running to completion in one block; and
a `busy_timeout` bound on lock waits. The durable cure — making DB access itself
async so a query never blocks the loop — is the ADR-0007 libsql model; until
that merge these bound the blast radius on the synchronous engine. The monitor
observes, it cannot pre-empt: it turns a silent freeze into a logged one.
_Avoid_: watchdog (reserved for Guardrail), throttle

### Statistics

The **Stats** page's derived metrics, over an Attempt set in a range. All keep the
honest-numbers discipline (floors shown as `≥`, unpriceable Usage flagged
`incomplete`, `—` never a fake zero). The three with a contested definition are
governed by ADR-0008.

**Cache hit rate**:
The share of an Attempt set's input-side tokens served from cache:
`read / (input + read + write)` — cache-read tokens over fresh input plus
cache-read plus cache-write. The denominator **includes cache-write**, so
priming the cache counts against the rate until it pays back (ADR-0008,
matching the reference project). A higher rate is cheaper Usage, not faster
work.
_Avoid_: cache efficiency, hit ratio

**Active-execution duration**:
**The sum of agent time only**: the time agents (builder, critic,
conflict-resolve turns) actually worked an Attempt. Time not spent with
agents never counts — scheduling waits, git operations, merge and post-merge
checks, escalated idle time are all excluded. Reported as **p50 / p95**
across the set; where agent-time facts are missing (historical rows),
wall-clock finish − start is the recorded fallback (ADR-0008).
_Avoid_: run time, wall-clock, elapsed

**Failure rate**:
Failed Attempts over total Attempts, at Attempt grain: a failed Attempt
counts, and **a review rejection is a failed Attempt** (the loop's uniform
outcome). Cancelled work is deliberate abandonment and stays out of the
numerator, shown separately in the state breakdown, which is always rendered
beside the rate (ADR-0008).
_Avoid_: error rate, success rate (its complement is not this)

**Avg cost / attempt**:
Total Cost over the range divided by Attempt count. A **floor** (`≥`) when
any Attempt in the range is unpriceable — the aggregate is flagged
`incomplete` rather than counting a missing price as zero (see Cost).
_Avoid_: mean spend

**Cache savings**:
The dollar delta caching returned — cache-read tokens priced at the gap between
the full input price and the cache-read price
(`read × (inputPrice − cacheReadPrice)`). Shown beside Cost as "what caching
saved," never subtracted from Cost.
_Avoid_: discount, rebate

**Per-tool token attribution**:
Output tokens — and their Cost — attributed to the tools an Attempt called, by
splitting each turn's output tokens across that turn's tool-use blocks by
count-share; a turn that called no tool goes to a separate **reasoning** bucket.
Covers the whole Process Tree, Subagents included.
_Avoid_: tool cost, per-tool spend

### Operations

**Operation**:
A discrete, atomic action Harmonic's own runtime performs — polling a Tracker,
picking and starting a Task, driving an Attempt, verifying, merging a task
branch (with its post-merge check), integrating an Epic, retiring a Session.
Modelled as an OpenTelemetry **span**: it has a start, an end, a duration, a
pass/fail status, and **nests** (a merge Operation contains its git and
post-merge-check children; an Epic contains its Members). Ephemeral and
**in-memory only** — never persisted to the DB. The set of currently-open
spans *is* the live "what is Harmonic doing right now" view; finished
Operations survive only as exported telemetry and rolled-up counts. An
Operation is something *Harmonic* does, **not** something the agent does
inside an Attempt: an Attempt is one Operation, but the agent's internal
tool-calls and Subagents are Activity / Usage, never decomposed into
Operation spans. **An action taken with no span or log entry is a defect**
(ADR-0010). High-frequency internal ticks (usage tailer, guardrail timers,
the event-loop probe) emit logs or metrics but open no span.
_Avoid_: job, action (too vague), event (that is an Activity Event / Fact),
task

**Scheduled Job**:
A recurring piece of Harmonic's own housekeeping that runs on a fixed cadence —
the Tracker poll, the Session-retirement sweep, worktree reconciliation, the
metrics summary. The persistent *schedule* (interval, last run, last result,
next run) that **fires an Operation each tick** — a cron entry to the
Operation's invocation. A single **Scheduler** owns every Job's timer,
single-flight and yield-aware; membership uses the same "discrete, can-fail,
worth-a-name" bar as an Operation, so sub-second internal ticks are excluded.
The **Tracker poll is modelled per-Workspace** — one Job instance per
Workspace, added/removed with the Workspace and shown *disabled* when its
Tracker will not resolve. Surfaced **read-only** on the Operations page
(interval / last run / next run / result), each row linking to its firing's
Operation span and logs. Unlike an Operation its schedule state is
**persisted**, so "last ran" survives the restarts under which the ephemeral
span surface resets. Governed by ADR-0010.
_Avoid_: routine, cron job (rejected names for this concept), task (a Scheduled
Job is Harmonic's housekeeping, never a unit of agent work). Note: "job" is
otherwise avoided (see Task, Operation) — **Scheduled Job** is the one sanctioned
compound.

### Interfaces

**Activity**:
The instance-wide live view of every in-flight harness process — Attempts and
active Conversations across all Workspaces — showing realtime Usage, context
fill, Cost, each Agent's last tool, and each process's Process Tree. **Strictly
read-only**: the sole interaction is a deep-link to an Agent's Task or
Conversation page, where every action lives (Stop/Kill, permission answers,
escalation resolve). It holds no state and carries no action affordances of its
own — a permission that needs the operator is raised app-wide (top of every
page), never surfaced here.
Distinct from **Operations**: Activity answers *what are the agents doing*
(agent / Subagent internals — usage, tools, context), Operations answers *what
is Harmonic's runtime doing* (orchestration). An Attempt appears in both — as
agent internals in Activity, as one orchestration span in Operations.
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
An ephemeral bearer token Harmonic mints per execution and injects into the
spawned Harness so agents reach MCP without setup. Deleted outright when
the execution finishes (a startup sweep removes orphans); never listed or
shown in the UI. (Renames to Attempt Key with the ADR-0001 epic.)
_Avoid_: scoped key, per-run API key

**Conversation Key**:
The Conversation analogue of a Run Key — an ephemeral bearer token minted
per Conversation and injected into its Harness (same `HARMONIC_API_KEY` /
`HARMONIC_MCP_URL` mechanism) so the chatting agent can reach MCP (e.g.
create Tasks mid-conversation). Deleted when the Conversation ends; the
startup sweep removes orphans. Never listed or shown.
