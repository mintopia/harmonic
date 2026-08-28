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

### Tickets

**Ticket**:
The board unit of autonomous work — a prompt plus execution settings (Harness,
model, Working Directory, Isolation Mode) that moves through the lifecycle,
native or mirrored. Worked in one branch by a loop of Attempts. Governed by
ADR-0041.
_Avoid_: task (a Task is a step within an Attempt), job, item

**Attempt**:
One iteration of a Ticket's implement→verify loop: its Tasks run in a fixed
order (Rebase → Implementation → Verification per command → Review) and end at
a verdict. A failed verdict feeds the next Attempt on the same Ticket and same
branch (counter +1); `maxAttempts` reached → *escalated*. The Attempt is the
history unit on the Ticket page and carries the counter — which counts
implementation failures only (a base-moved re-verify, or a commit-your-work
nudge, increments nothing). The system never creates a new Ticket in response
to failure.
_Avoid_: retry, reattempt (the old loop mechanisms Auto-Retry and reattempt
collapsed into this counter). Not _Run_: a Run is one harness execution / prompt
turn that **coexists** with Attempt (ADR-0047) — the Attempt owns the counter, a
Run references it. Not _self-heal_ either: that mechanism survives as a within-Run
turn purpose (its budget folded into Max Attempts, #310).

**Task**:
One individually undertaken step within an Attempt, each a timeline row with
its own logs and outcome: the **Rebase Task** (rebase the ticket branch onto
the current base; conflicts are work the agent resolves here), the
**Implementation Task** (the agent implements and commits — only the agent
ever commits), one **Verification Task** per configured command (ordered,
fail-fast), and the optional **Review Task** (the critic).
_Avoid_: run, phase (both real, but Run-scoped and coarser — a Task is the finer
Attempt step; see Run, Phase), stage, step

**Task Event**:
One ACP `session/update` (message chunk, thought, tool call, plan update)
persisted against a Task's execution; the source of truth for observability.
_Avoid_: log line, message

**Fact**:
An immutable row in the append-only fact log that is the coordination spine:
every decision-grade signal an Attempt's Tasks emit (agent-finish, verdicts,
failures) is one timestamped row with a monotonic `seq`. Every lifecycle
transition is a deterministic function of recorded Facts — agent judgment
lives inside the Implementation and Review Tasks, never in routing.
_Avoid_: event (that is the Task Event stream), log line, marker

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
owns its execution state (Attempts, Usage) and writes only claim/close back. A
re-poll upserts it. Never enters *draft* — a tracker issue is already
authored. Runs the same lifecycle as a native Ticket; tracker writes are
output side-effects, never a control path (see Agent-workable).
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
is the unit its children are scheduled and merged as a group by. An Epic is a
**container**: it neither **blocks** its children (a `Blocked by: #<epic>` edge
is never projected — an Epic contains, it does not gate) nor **runs** (it is
never agent-workable, so the Auto-Runner never executes the container itself).
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

**Agent-workable**:
The derived flag that makes a Ticket eligible for pickup: `ready-for-agent`
present (the positive opt-in gate, re-synced from labels on every re-poll,
issue #230) AND no open Blockers. Never stored. **HITL is not in Harmonic**:
a mirrored issue without the label is a human-only Ticket — it stays visible
on the board (it may block others; rendered muted with a distinct HITL icon)
but takes no actions and is updated only by mirroring until the tracker
closes it. Assignment is never consulted. Ticket closure is a tracker act,
mirrored in as an **output side-effect, never a control path** (ADR-0041,
superseding ADR-0011's closure-as-success): success is the verification
verdict plus merge.
_Avoid_: drive, afk, hitl (as stored modes — all deleted), mode, assignee

**Escalation**:
The *escalated* state and the single human surface. A Ticket reaches it only
via: (1) attempt counter exhausted, (2) branch-contract violation (the agent
worked outside its branch/worktree — should never happen; escalate when it
does), (3) permanent infrastructure failure (git circuit-breaker class).
Exactly three actions there: **Reject with guidance** (guidance becomes
feedback, counter resets, the loop resumes), **Accept** (counts as success;
the normal merge/close/cleanup path continues), **Close** (closes the Ticket
and cleans up: branch, worktree, tracker issue). Escalated Epics surface in
the same attention section.
_Avoid_: downgrade, fallback, handoff, adopt / note-to-critic / un-escalate
(deleted escape hatches, ADR-0027 superseded)

**Drive Prompt**:
The prompt Harmonic injects to auto-run a mirrored Ticket: a **global**
settings template (no per-Task override) of a workflow slash-command plus a
short preamble, filled from the Task — `{skill}` from its Workflow /
Wayfinder Type (research→`/research`, implement→`/implement`), plus `{ref}`
`{url}` `{title}` `{body}`. The preamble tells the agent to resolve the ticket
end-to-end and comment + close it via the tracker doc's `gh` mechanics; the
skills stay the source of truth. The Run then streams Run Events like any Run
— no separate visibility path.
_Avoid_: injected command, auto-prompt

**Merge Fate**:
What becomes of a worktree Run's branch when a mirrored Ticket's Attempt
passes verification — **auto-merge** (default: merge onto the base at the
verified SHA; a stale base re-enters Rebase → Verification, a conflict is a
failed Attempt),
**open-PR** (branch → GitHub PR, review off-Harmonic), or **artifact** (leave
the branch for a human/CI). Global default, per-Task override; worktree-only
(direct isolation has no branch). Research findings branches are always
artifacts regardless.
_Avoid_: merge policy

**Max Attempts**:
The configured bound on a Ticket's Attempt loop (global default, per-Workspace
override). Exhausting it is escalation trigger (1) — never a silent retry
beyond the cap, never a new Ticket. Replaces Auto-Retry and reattempt, and folds
in self-heal's old per-turn budget (#310) — though the self-heal turn purpose
itself survives as a Run mechanism (ADR-0041, amended by ADR-0047).
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
worktrees fork off it and a rebase would rewrite history under them),
serialized through the merge train. A refresh conflict gets one bounded agent
merge-resolution turn; failure escalates the **Epic**. Refresh is why the
Whole-Epic integrate is clean by construction. "Rebase" is reserved for ticket
branches (single-writer, safe).
_Avoid_: sync, catch-up merge

**Member**:
A direct child ticket of an Epic — one Member, one Task/Run — run concurrently
with its siblings, each in its own worktree cut from the Integration branch.
_Avoid_: child task, subtask

**Ready frontier**:
The subset of an Epic's Members currently runnable — **agent-workable** (the
same derived flag, issue #230), *open*, and free of
any open non-Epic Blocker — recomputed every poll; the true width of
parallelism, not the whole Epic at once. Informally a **wave**: the next wave is
the frontier re-derived after blockers clear. Never a stored or numbered entity.
_Avoid_: wave (as a stored/numbered thing), batch

**Merge train**:
The single-writer, strict-FIFO mechanism that merges finished Members onto one
Integration branch one at a time — rebase onto the current tip, then
fast-forward — so landings never interleave and history stays linear. Different
Epics' branches merge in parallel; only same-branch Members queue.
_Avoid_: merge queue, integration pipeline

**Heal (merge)**:
The one bounded corrective turn handed back to a conflicting Member's own warm
Session to resolve a rebase conflict, dispatched out-of-band so siblings aren't
stalled. A second conflict Escalates — there is no second Heal.
_Avoid_: retry, auto-resolve

**Member merge status**:
Where a Member sits from the Epic's view — **pending** (working / not started),
**completed** (its work is folded into the Integration branch), or **blocked**
(escalated / cancelled — a Blocking Member that
holds the whole Epic back). Mid-merge a Member may also read **healing** (a
corrective turn) or **escalated**.
_Avoid_: merge status

**Blocking member**:
A Member whose merge status is *blocked* that stalls the whole Epic on the
automatic path until it clears or the operator Force-integrates.
_Avoid_: stuck task

**Whole-Epic Verification**:
The Verification run against the Integration branch tip once the integrate gate
opens — the same command primitive as per-Run Verification — catching breakage
in the union of Members that each passed alone. A non-pass fail-safe Escalates;
Verification never self-heals at Epic scope.
_Avoid_: final check

**Whole-Epic integrate**:
Merging the Integration branch into the default branch in one atomic go and
retiring the branch — only when the integrate gate is open and Whole-Epic
Verification passes.
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

The stored Ticket states (ADR-0041). Blocked-ness and agent-workability are
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
The Ticket-level step after a passing verdict: assert the ticket branch still
points at the verified SHA, then merge — onto the Integration branch for an
Epic Member (via the merge train), onto develop otherwise. If the base moved
since the verdict, the Ticket re-enters Rebase → Verification without
re-implementing and without touching the counter; with the freshness gate a
merge conflict cannot otherwise occur. Merge mints no synthetic candidate
commit: the verified-tree-is-merged-tree guarantee is the SHA assertion. (The
**Candidate** ref itself is not deleted — it is the worktree-isolation freeze
kept by ADR-0046; ADR-0047 corrects ADR-0041 on this.)
_Avoid_: accept, merge gate

### Execution

**Run**:
One execution of a Ticket's work by a Harness — a single harness process and
prompt turn, on branch `harmonic/task-<id>-run-<n>` in worktree mode. The unit
Usage, Cost, and Guardrails attach to, that a Session prompts over, and that
crash recovery reasons about. A Run carries a **Phase** and, in worktree mode, a
**Candidate** ref. Run and **Attempt** coexist (ADR-0047, correcting ADR-0041's
"Run is deleted"): a Run is one execution; an Attempt is one implement→verify
iteration and is the ledger that owns the attempt counter. Today that counter is
still double-booked — `runs.attempt` and `attempts.number` kept in step by hand —
which ADR-0047 resolves by making the Attempt row the single source of truth a Run
references by FK (that FK is follow-up work, not yet in the schema).
_Avoid_: attempt (the loop-iteration ledger, not the execution), job

**Phase**:
The coarse execution stage of a Run — `executing → validating → verifying →
merging → terminal` (`src/domain/run-phases.ts`). Not cosmetic: it scopes
guardrail trips and routes crash recovery (which running Runs get force-failed on
boot keys off Phase). Distinct from an Attempt's **Tasks**, the fine-grained
timeline rows; Phase and Task coexist (ADR-0047).
_Avoid_: stage, status; Ticket *state* is a separate axis

**Candidate**:
In worktree mode, a Run's frozen tree snapshot — a private
`refs/harmonic/candidate/run-<id>` ref — that the verifiers run against, so the
verified tree is the tree that merges. Kept and extended by ADR-0046
for worktree-completion reconciliation; ADR-0041's "candidate machinery deleted"
is corrected to coexistence by ADR-0047. Merge itself still
asserts the verified SHA rather than minting a synthetic candidate commit.
_Avoid_: snapshot commit, stash

**Self-heal**:
A corrective execution turn (`src/domain/turn-queue.ts`, a `TURN_PURPOSES`
member — distinct from the Conversation-level **Turn**) that re-enters a Run's
`validating` phase to fix a failed verification on the same branch. Its old
per-turn budget folded into **Max Attempts** (#310), but the
mechanism remains load-bearing — turn-queue admission, git-ref handling, crash
recovery, and the verification-attempt UI all use it (ADR-0047 corrects
ADR-0041's "self-heal deleted").
_Avoid_: retry, auto-retry (those are Attempt-level; self-heal is a within-Run turn)

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
retained through the human-rejection window (so a reject-and-continue merges in the
same workspace) and removed only when the Session retires — on a successful merge,
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
House Rule: it will not start a Run into a Work Context already occupied by a
working Ticket's Run.
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
Run per Work Context** may be working at once, so unverified work is never
stacked on top of. Enforced by the Auto-Runner as a pick predicate.
_Avoid_: workspace (that is the board container), sandbox

**Verification**:
The automated gate between implementation and Merge, run inside each
Attempt: `verify.commands[]` (ordered, fail-fast, one Verification Task each)
then the optional **Review Task** — a single critic Harness with configurable
harness, model, and prompt, run only after the commands pass. Resolved global
default with per-Workspace override; zero verifiers configured = the gate
passes. Any command fail, review reject, or review *inconclusive* is a
**failed Attempt** — feedback into the next Attempt, counter +1 (ADR-0041,
revising ADR-0021's inconclusive-escalates). Runs against the branch head SHA,
which Merge then asserts.
_Avoid_: review gate (deleted); validation — the Run's `validating` **Phase** is
a real but distinct concept (the coarse execution stage), not this Attempt-level
gate; lint, test (it is more than either)

**Continuation rule**:
The deterministic choice at Attempt N+1: continue the prior Session (feedback
appended) iff its context usage is below `contextReuseThreshold` (config,
default 0.2) AND it is warm within a fixed per-Harness constant seeded from
known provider cache TTLs; otherwise a fresh Session seeded by the condensed
summary (issue #170 machinery) plus the feedback. The repo is the diff —
nothing else is passed.
_Avoid_: session reuse policy, cache gate

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

**Event-loop guarantee**:
The promise that nothing — a slow query or a background loop — can freeze the
whole server (issue #200, ADR-0029). Harmonic runs synchronous SQLite on the
one Node event loop shared by every request, so a single blocking stretch stalls
*all* HTTP at once. Three defences hold the promise: an **Event-loop monitor**
(`src/reliability/event-loop-monitor.ts`) that probes loop delay and logs a
stall as a legible event; the **loops-must-yield** rule — any background loop or
heavy in-request scan that iterates many items hands the loop back on a
wall-clock budget via `forEachYielding` / `yieldToEventLoop`
(`src/reliability/yield.ts`) rather than running to completion in one block; and
a `busy_timeout` bound on lock waits. The durable cure — making DB access itself
async so a query never blocks the loop — is the ADR-0029 libsql migration; until
that merge these bound the blast radius on the synchronous engine. The monitor
observes, it cannot pre-empt: it turns a silent freeze into a logged one.
_Avoid_: watchdog (reserved for Guardrail), throttle

### Statistics

The **Stats** page's derived metrics, over a Run set in a range. All keep the
honest-numbers discipline (floors shown as `≥`, unpriceable Usage flagged
`incomplete`, `—` never a fake zero). The three with a contested definition are
governed by ADR-0028.

**Cache hit rate**:
The share of a Run set's input-side tokens served from cache:
`read / (input + read + write)` — cache-read tokens over fresh input plus
cache-read plus cache-write. The denominator **includes cache-write**, so
priming the cache counts against the rate until it pays back (ADR-0028, matching
the reference project). A higher rate is cheaper Usage, not faster work.
_Avoid_: cache efficiency, hit ratio

**Active-execution duration**:
How long a Run's agent actually worked: the `agent-finish` run_fact's timestamp
minus the Run's start. It **excludes the review-park and merge wait** that
follow agent-finish, so it is the agent's working time, not calendar time through
the Phase pipeline. Falls back to wall-clock (finish − start) only when a Run has
no agent-finish fact; reported as **p50 / p95** across the set (ADR-0028).
_Avoid_: run time, wall-clock, elapsed

**Failure rate**:
`failed / total` Runs — **failed-only**. Cancelled Runs and review-rejected Runs
are counted and shown separately in the run-states breakdown, never folded into
the numerator: the rate reflects genuine execution failure, not deliberate
abandonment or a reviewer's no (ADR-0028).
_Avoid_: error rate, success rate (its complement is not this)

**Avg cost / run**:
Total Cost over the range divided by Run count. A **floor** (`≥`) when any Run in
the range is unpriceable — the aggregate is flagged `incomplete` rather than
counting a missing price as zero (see Cost).
_Avoid_: mean spend

**Cache savings**:
The dollar delta caching returned — cache-read tokens priced at the gap between
the full input price and the cache-read price
(`read × (inputPrice − cacheReadPrice)`). Shown beside Cost as "what caching
saved," never subtracted from Cost.
_Avoid_: discount, rebate

**Per-tool token attribution**:
Output tokens — and their Cost — attributed to the tools a Run called, by
splitting each turn's output tokens across that turn's tool-use blocks by
count-share; a turn that called no tool goes to a separate **reasoning** bucket.
Covers the whole Process Tree, Subagents included.
_Avoid_: tool cost, per-tool spend

### Operations

**Operation**:
A discrete, atomic action Harmonic's own runtime performs — polling a Tracker,
picking and starting a Task, driving a Run, verifying, merging a worktree,
merging an Epic, retiring a Session. Modelled as an OpenTelemetry **span**: it
has a start, an end, a duration, a pass/fail status, and **nests** (a member-merge
Operation contains its `rebase`/`ff` git children; an Epic contains its Members).
Ephemeral and **in-memory only** — never persisted to the DB. The set of
currently-open spans *is* the live "what is Harmonic doing right now" view;
finished Operations survive only as exported telemetry and rolled-up counts. An
Operation is something *Harmonic* does, **not** something the agent does inside a
Run: a Run is one Operation, but the agent's internal tool-calls and Subagents
are Activity / Usage, never decomposed into Operation spans. Scope is *everything
non-trivial* — a discrete action that can fail — so high-frequency internal ticks
(usage tailer, guardrail timers, the event-loop probe) emit logs or metrics but
open no span.
_Avoid_: job, action (too vague), event (that is a Run Event / run_fact), task

**Scheduled Job**:
A recurring piece of Harmonic's own housekeeping that runs on a fixed cadence —
the Tracker poll, the Session-retirement drain, orphan-worktree reconcile, the
Work Context lease sweep, the review-SLA sweep, epic reconcile. The persistent
*schedule* (interval, last run, last result, next run) that **fires an Operation
each tick** — a cron entry to the Operation's invocation. A single **Scheduler**
owns every Job's timer, single-flight and yield-aware; membership uses the same
"discrete, can-fail, worth-a-name" bar as an Operation, so sub-second internal
ticks are excluded. The **Tracker poll is modelled per-Workspace** — one Job
instance per Workspace, added/removed with the Workspace and shown *disabled*
when its Tracker will not resolve. Surfaced **read-only** on the Operations page
(Sonarr-style: interval / last run / next run / result). Unlike an Operation its
schedule state is **persisted**, so "last ran" survives the restarts under which
the ephemeral span surface resets. Governed by ADR-0038.
_Avoid_: routine, cron job (rejected names for this concept), task (a Scheduled
Job is Harmonic's housekeeping, never a unit of agent work). Note: "job" is
otherwise avoided (see Task, Operation) — **Scheduled Job** is the one sanctioned
compound.

### Interfaces

**Activity**:
The instance-wide live view of every in-flight harness process — Runs and
active Conversations across all Workspaces — showing realtime Usage, context
fill, Cost, and each process's Process Tree. Read-only but for a per-process
Stop/Kill and a deep-link to a related ticket; holds no state of its own.
Distinct from **Operations**: Activity answers *what are the agents doing*
(agent / Subagent internals — usage, tools, context), Operations answers *what is
Harmonic's runtime doing* (orchestration). A Run appears in both — as agent
internals in Activity, as one orchestration span in Operations.
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
