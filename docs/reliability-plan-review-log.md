# Plan Review Log: Harmonic reliability design (Guardrails / Sessions / Verification / Work Context / branching)

Started session. MAX_ROUNDS=5.
PLAN_FILE=docs/reliability-design.md (backing: docs/adr/0019-0023)
LOG_FILE=scratchpad/reliability-plan-review-log.md
Reviewer model: Codex CLI default (codex-cli 0.145.0). Read-only every round.

## Round 1 — Codex (VERDICT: REVISE)

The plan is not implementable safely yet. Several “locked” decisions rely on unverified harness behavior, and the required state-machine and persistence changes are underspecified.

### Unit C — Session and resume

- **Cache warmth is incorrectly treated as a correctness boundary.** `session/load` restores conversation state whether the provider’s prompt cache is warm or cold; warmth changes latency/cost, not whether reuse is semantically valid. **Fix:** Decide resume eligibility from session compatibility and operator policy, and use estimated cache warmth only as cost information.

- **The claimed cache windows are not knowable constants.** `ENABLE_PROMPT_CACHING_1H=1` is merely a request/configuration input; provider routing, model choice, adapter behavior, subscription mode, and cache eviction can invalidate the estimate. **Fix:** Store `lastActiveAt` and an explicitly named `estimatedWarmUntil`, never promise that the session is warm.

- **The Codex “~5 min, ~30 min on GPT-5.6+” and Copilot assumptions are unsupported protocol guarantees.** Encoding them as behavioral boundaries will silently produce wrong automatic choices. **Fix:** Treat per-harness windows as configurable cost heuristics with conservative defaults and record the source/version used.

- **The human-reject choice is conceptually backwards.** A cold session can still be loaded correctly, while a “fresh session with summary” loses context; the dialog currently frames load versus fresh primarily around elapsed time. **Fix:** Offer “continue full conversation” versus “start condensed conversation,” show estimated cost/latency, and do not disable either based on TTL.

- **`session/load` requires more than the persisted `sessionId`.** A resumed process must reconstruct the correct harness, model, cwd, MCP servers/credentials, permission mode, adapter version, and likely load-request parameters; the Run row currently supplies neither a durable Session record nor compatibility constraints. **Fix:** Add a Session entity containing harness/model/cwd/work-context identity, timestamps, capability snapshot, adapter/config version, status, and run bindings.

- **Worktree sessions cannot naively resume.** The current settle path deletes `dataDir/worktrees/run-<id>`, while a loaded session was created against that cwd; a retry also creates a different branch and worktree. **Fix:** Specify whether resumable Sessions retain their worktree, recreate it at the same absolute path and branch, or deliberately start a fresh Session when cwd identity cannot be restored.

- **Crash recovery cannot “reattach” to an interrupted prompt.** `session/load` restores persisted conversation history; it does not restore the killed process, outstanding JSON-RPC request, half-executed tool, or exact agent control point. **Fix:** Model recovery as a new Run and new prompt turn after repository reconciliation, with an explicit crash-recovery prompt and idempotency checks.

- **Persisting `agentFinished` or `escalateReason` does not reconstruct in-flight execution.** If either signal was committed before the crash, recovery should settle rather than resume; if it was not committed, persistence cannot recreate it. `steerQueue` is not even Runner state today. **Fix:** Persist durable signals as append-only Run facts and derive recovery disposition from them; do not describe volatile request state as resumable.

- **Loading a Session can resurrect expired credentials.** The original run-scoped MCP key is revoked at finalization/boot, while session history and MCP configuration may reference it. **Fix:** Require load to rebind fresh MCP server credentials and test each harness’s behavior when loaded session configuration differs.

- **Loaded sessions need capability, model, and permission-mode revalidation.** The plan assumes a prior `session/new` configuration survives load, but the current driver obtains modes from `session/new` and sets model/mode afterward. **Fix:** Define and test the load handshake per harness, including capability check, returned modes, model verification, mode reset, and failure fallback.

- **The keepalive contradicts the decision not to retain harness processes.** Sending a prompt requires spawning a process, loading the session, and completing a turn; it is not a cheap client-side timer operation. **Fix:** Drop keepalive in v1 unless measured savings justify a separately scheduled load-and-prompt job.

- **A “no-op” prompt is not operationally a no-op.** An autonomous agent may inspect files, run tools, modify the branch, call Harmonic tools, or finish/escalate; it can also collide with verification or review. **Fix:** Never use agent turns as cache pings unless the harness exposes a side-effect-free cache-touch primitive.

- **Keepalive can extend itself forever and consume queue or provider capacity.** There is no maximum hold duration, ownership lease, cancellation behavior, or accounting. **Fix:** If retained, impose a hard expiry, separate concurrency quota, explicit cost budget, and single-flight lease.

- **Resume failure behavior is unspecified.** A harness may advertise load support yet reject a missing, corrupt, migrated, or inaccessible session. **Fix:** Define load failure as a classified event with one safe fallback to a new summarized Session, never an unbounded retry.

### Work Context house rule

- **The worktree-mode predicate cannot know the proposed Work Context before starting the Run.** Its branch and path include `run.id`/attempt and are created inside `Runner`, after Auto-Runner selection. **Fix:** Define the prospective context deterministically before claiming, or state explicitly that the predicate applies only to direct mode.

- **In worktree mode the rule is vacuous.** Every Run gets a unique directory and branch, so it prevents no collision and adds complexity without protecting the shared base repository during merge/worktree creation. **Fix:** Enforce a direct-mode working-directory lease and separate short repository-operation locks for worktree creation, merge, and removal.

- **For direct mode, `(directory, current branch)` is unstable during selection.** Another Run or operator can switch HEAD between predicate evaluation and spawn, causing both incorrect admission and incorrect recorded branch. **Fix:** Acquire an atomic lease keyed by canonical repository/worktree identity before changing the Task to running, then read and persist HEAD under that lease.

- **A scheduler predicate alone is race-prone.** Manual starts, API callers, multiple Harmonic processes, and asynchronous claim paths bypass or race the in-memory Auto-Runner check. **Fix:** Back the rule with a database lease/unique constraint or enforce it centrally in `Runner.start` and `launchClaimed`, not only in `pickNext`.

- **“Running or awaiting verification/review” has no durable ownership model.** Verification has no Task or Run state, while native `awaiting-review` may last indefinitely and mirrored Tasks explicitly never enter that state. **Fix:** Introduce a durable context lease with phase, owner Run, heartbeat, and expiry/release rules instead of inferring occupancy from Task states.

- **One abandoned native review can starve the context forever.** There is no review SLA, lease expiry, supersede action, archive path, or operator-visible reason why later Tasks remain ready. **Fix:** Add explicit context-unlock/supersede controls and expose the blocking Task/Run in queue diagnostics.

- **A crashed verification can also block indefinitely if occupancy is persisted before boot recovery understands the new phase.** **Fix:** Define boot-time lease reconciliation and make verification ownership recoverable or expirable.

- **FIFO is defeated by blocked high-priority Tasks.** Although `pickNext` filters candidates, the design does not require surfacing context-block reasons or fair selection among contexts, allowing a busy context to monopolize repeated opportunities. **Fix:** schedule by eligible context and expose skipped reasons plus wait duration.

### Unit D — Branch-contract enforcement

- **“No stray branch holds the work” is not a computable invariant.** Git does not identify which newly created branches “belong” to an agent, and commits may be reachable from several refs or none. **Fix:** Define concrete checks: expected HEAD, expected worktree association, recorded start commit, changed refs observed during the Run, and commit reachability from the intended branch.

- **Recording only the starting branch is insufficient.** A branch can be reset, force-moved, deleted, checked out detached, or advanced by another actor while retaining the same name. **Fix:** Persist repository identity, start branch, start commit OID, expected worktree path, and initial dirty-state fingerprint.

- **Detached HEAD is not addressed.** `rev-parse --abbrev-ref HEAD` returns `HEAD`, which is not a safe merge target and can be mis-recorded as an ordinary branch. **Fix:** Reject or explicitly support detached starts by recording the commit and requiring an operator-selected landing branch.

- **Direct-mode dirty trees make attribution impossible.** Harmonic cannot tell pre-existing changes from agent changes, and asking the agent to merge can commit or overwrite operator work. **Fix:** Require a clean direct Work Context for afk execution, or snapshot/index the initial state and escalate rather than auto-recover when it is dirty.

- **Submodules and nested repositories escape the check.** Top-level HEAD can be correct while submodule HEADs or nested repos were switched and contain the actual work. **Fix:** Either declare them unsupported for automatic branch recovery or persist and verify recursive repository state.

- **Detection currently comes too late relative to workspace finalization.** Runner commits everything and removes a worktree before settle logic; once removed, a corrective turn has no original cwd and may have already snapshotted work on the wrong branch. **Fix:** Run contract validation before commit/removal, then snapshot only after the expected branch is restored.

- **Agent-directed re-merge is unsafe and nondeterministic.** The agent may create more branches, merge the wrong direction, rewrite history, include unrelated dirty work, or report success without satisfying the invariant. **Fix:** Prefer deterministic Git recovery based on recorded OIDs/ref deltas when unambiguous; otherwise preserve artifacts and escalate without another mutating agent turn.

- **A corrective turn in the “same Session” may target a deleted or changed Work Context.** **Fix:** Keep the exact workspace alive through validation/recovery or do not attempt automated recovery.

- **The corrective turn has no transaction boundary with operator activity.** In direct mode an operator can edit or switch branches while recovery runs. **Fix:** Hold the Work Context lease through validation and recovery and verify the start OID again immediately before mutation.

- **The violation check can race merges and reviews.** HEAD may be correct at check time and change before auto-merge or task settlement. **Fix:** perform validate-and-land under a repository lock with a final compare-and-swap check on relevant refs.

- **Escalation does not say how the evidence is preserved.** Removing a worktree or revoking the process before recording ref/OID/status details makes manual recovery difficult. **Fix:** persist a structured branch-violation report and retain the worktree/refs until operator disposition.

### Unit A — Guardrails

- **Trip, cancel, and settle have no precedence rule.** A budget timer can race `finish_task`, process exit, operator cancellation, or auto-merge and produce contradictory Run/Task outcomes. **Fix:** define a single atomic terminal-decision operation with explicit precedence and idempotent cancellation/finalization.

- **“Wall-clock always guards” contradicts “any subset enabled.”** It is unclear whether wall time is mandatory or can be disabled. **Fix:** choose one rule and validate configuration so every afk Run has at least one enforceable hard bound.

- **Cost-to-token fallback is undefined when no token budget exists.** The prose says cost falls back to tokens, then relies on wall clock, which does not constrain spend. **Fix:** reject a cost-only configuration for unpriced models or require a configured fallback token limit.

- **A token limit cannot be reliably enforced from the current live usage path.** Usage is sampled from harness-native logs, is best-effort, may lag, and may omit model splits or subagents. **Fix:** specify authoritative counters, acceptable overshoot, polling cadence, missing-data behavior, and cumulative accounting across continued/self-heal turns.

- **Cost configuration can change during a Run.** Repricing halfway through changes whether and when it trips. **Fix:** snapshot the effective guardrail configuration and price table on Run start.

- **The progress detector lacks a definition of progress.** Repeated tool/result shapes can be legitimate pagination, compilation retries, test minimization, or batched edits; “monologue” is not inherently stalled. **Fix:** publish deterministic features and thresholds, persist detector state, and test against recorded real event traces before enabling by default.

- **Long-running tools will false-positive because ACP may emit no events while a command runs.** **Fix:** suspend idle detection while a tool call is outstanding and require either tool heartbeat/process activity or a separate generous hard tool timeout.

- **A steer nudge cannot necessarily interrupt a running prompt.** Runner currently has no steer queue; Conversation steering cancels the current turn and starts another, which changes semantics and can leave a tool half-executed. **Fix:** specify whether a nudge queues after the turn or cancels it, and implement one single-flight control path with persisted intent.

- **The nudge can race the continue loop and self-heal prompts.** Multiple producers may prompt the same ACP Session concurrently. **Fix:** serialize all Session turns through a durable per-Session turn queue and assign each turn a purpose and budget.

- **Guardrail budget scope is ambiguous across Run versus Session reuse.** New Runs in the same Session could reset cost and token limits, making automatic retries an easy budget bypass. **Fix:** define separate per-Run and per-Task/attempt-chain budgets, with cumulative usage carried across retries and self-heals.

- **Escalation reason alone is insufficient observability.** Operators need limit, observed value, threshold, detector evidence, timestamp, nudge outcome, and configuration source. **Fix:** persist structured guardrail-trip events and derive the short card reason from them.

### Unit B — Verification

- **The verification insertion point conflicts with current cleanup.** Runner kills the harness, commits/removes the worktree, and then calls auto-drive settlement; verification cannot run “in the Work Context at settle” after that ordering. **Fix:** define an explicit pipeline: agent turn → branch validation → snapshot → verification/self-heal cycles → final snapshot → merge/review → cleanup.

- **Verification has no durable state.** A crash between completion, command verification, agent verification, self-heal, and merge cannot be recovered safely. **Fix:** persist verification attempts, mechanism, input commit/tree OID, verdict, output, and phase.

- **Verification must bind its verdict to an immutable revision.** Files can change after tests pass but before merge, especially in direct mode. **Fix:** verify a recorded tree/commit and recheck that exact OID immediately before accepting or merging.

- **Command semantics are underspecified.** There is no timeout, exit-code mapping, signal handling, output cap, environment policy, shell interpretation, or distinction between infrastructure failure and test failure. **Fix:** execute an argv-based command with explicit cwd/env, timeout, output limits, cancellation, and a documented verdict mapping.

- **“Command and/or agent” lacks combination rules.** It is unclear whether one pass overrides another failure or whether agent inconclusive dominates command pass. **Fix:** define a truth table; normally every configured verifier must pass and any fail/inconclusive blocks.

- **Agent verdict parsing is not defined.** Natural-language critic output cannot reliably yield pass/fail/inconclusive and is vulnerable to repository prompt injection. **Fix:** require a structured schema/tool result, validate it strictly, and treat malformed or missing output as inconclusive.

- **The critic’s trust boundary is missing.** Giving a verifier normal tools or Harmonic credentials lets it modify the code, accept its own work, or manipulate tracker state. **Fix:** run the critic read-only with no mutating MCP tools and bind its review to the candidate revision.

- **Self-heal in the same Session conflicts with “critic Harness with its own model.”** It is unclear whether the critic session or builder session performs the fix; using the critic session violates the stated builder context, while using the builder requires a separate persisted Session binding. **Fix:** explicitly route findings from a read-only verifier Session into the original builder Session for one serialized corrective turn.

- **Self-heal can invalidate earlier verifier results.** After any edit, every configured verification mechanism must run again, not only the one that failed. **Fix:** rerun the full verification suite against the new tree after each heal.

- **Self-heal cap and budgets are unspecified and interact recursively with guardrails.** **Fix:** define exact attempt counts and charge every verification/heal turn and command duration to the Task-level guardrail budget.

- **Inconclusive should not always trigger self-heal.** Infrastructure outages, missing commands, verifier crashes, and malformed output are not necessarily code defects and can cause pointless mutation. **Fix:** self-heal only actionable failures; escalate inconclusive immediately with its classified cause.

- **Replacing `agentReview` changes authorization semantics, not just configuration.** Today it controls exposure of mutating `accept_task`/`reject_task` APIs to run-scoped keys; removing the flag without an authorization migration may expose or orphan those routes. **Fix:** separately specify removal/deprecation of MCP tools, HTTP scoped-key policy, config migration, and existing-client behavior.

- **Native auto-accept behavior is contradictory.** The plan says verification runs before `awaiting-review`, but also says verifier pass “auto-accepts where configured”; it never defines whether native Tasks bypass human review. **Fix:** provide an origin × verification configuration × merge-fate state-transition table.

- **Mirrored success currently depends on the ticket being closed before merge.** Verification and self-heal may happen after the agent closes the ticket, leaving a closed ticket for code that subsequently fails verification. **Fix:** defer external completion/closure until verification passes, or define compensating reopen/escalation behavior.

- **Direct-mode verification cannot isolate the candidate from unrelated edits.** **Fix:** disallow automatic verification/acceptance on a dirty or concurrently editable direct context, or execute against an immutable temporary worktree.

The plan needs a concrete persisted state machine spanning Run, Session, verification phase, Work Context lease, and terminal decision. Without that, the four units will produce overlapping timers, prompts, repository mutations, and recovery paths that cannot be made race-safe merely by adding checks around the current settle function.

VERDICT: REVISE
### Claude's response (Round 1)
ACCEPTED nearly all findings. Core change: added the **coordination spine (§0)** —
(1) persisted coordination state (sessions/work_context_leases/verification_attempts/
guardrail_events/run_facts), (2) one serialized per-Session turn queue (single-flight;
all turn producers), (3) a single atomic terminal decision with precedence, (4) an
explicit settle pipeline (validate→snapshot→verify/heal→snapshot→merge/review→cleanup),
(5) a durable Work Context lease.
- Unit A: wall-clock mandatory bound; snapshot config+prices; cost→token reject-if-unpriced;
  best-effort token accounting spec; progress detector off-by-default + suspend-while-tool-outstanding;
  per-Run vs attempt-chain budgets; structured guardrail_events.
- Unit B: verify inside the pipeline bound to OID; read-only critic w/ structured verdict;
  builder-heals + full re-verify; inconclusive→escalate (not heal); agentReview replacement is an
  AUTHORIZATION migration; origin×config×merge-fate table; defer mirrored ticket-close until verify passes;
  no auto-verify on dirty direct context.
- Unit C: full Session entity; cache warmth = COST not correctness; resume = new Run+turn on loaded
  Session (not reattach); load handshake + MCP rebind + classified failure fallback; worktree retain-or-fresh;
  human-reject dialog reframed off TTL; KEEPALIVE DROPPED.
- Unit D: validate BEFORE commit/removal; persist start OID+dirty fingerprint; detached-HEAD + dirty +
  submodule handling; deterministic git recovery preferred, agent re-merge demoted to bounded fallback;
  land under repo lock + ref CAS; preserve evidence.
- Work Context: durable lease (not just a predicate); direct-mode dir lease + worktree repo-op locks;
  anti-starvation (expiry/supersede/diagnostics/boot reconcile).
REJECTED/nuanced: (a) dropping agent re-merge entirely — kept as a bounded, lease-held fallback behind
deterministic recovery per the operator's explicit decision (flagged); (b) "no steer queue" — steer exists
(ADR-0018), adopted the deeper serialize-all-turns point.

## Round 2 — Codex (VERDICT: REVISE)

The revision resolves most Round-1 concerns, but the coordination spine still defers several decisions that determine whether it is actually race-safe.

### Coordination spine

- **The “single atomic terminal decision” conflates ending agent execution with final Run disposition.** `agent-finish` must begin validation/verification, while later verification or branch failure may Escalate; a terminal CAS at agent-finish would prevent that. **Fix:** separate `execution_outcome` from the final terminal transition and model persisted pipeline phases such as `executing → validating → verifying → landing/review → terminal`.

- **A first-writer-wins CAS cannot enforce the stated precedence.** If process death wins the CAS just before an already-issued operator cancel or guardrail event is committed, the higher-priority outcome cannot replace it. **Fix:** serialize facts and terminalization through one coordinator transaction, define a cutoff/event ordering rule, and compute the winning disposition from all facts accepted before that cutoff.

- **The core schema and transition tables remain deferred to implementation.** Those tables are the proof that queue items, verification attempts, leases, recovery, and terminalization cannot enter impossible combinations. **Fix:** make the complete state-transition tables, ownership constraints, uniqueness rules, and crash recovery transitions part of this plan before implementation approval.

- **Queued turns need durable claim semantics, not just “single-flight.”** A crash after sending a prompt but before recording completion leaves a claimed item whose replay may duplicate mutations. **Fix:** define queue item states, lease/heartbeat, stable idempotency key, send/ack boundaries, and recovery of ambiguous `in_flight` items.

- **`boundRevision` is not meaningful for the initial, continue, or crash-recovery turns unless its validation behavior is specified.** **Fix:** define which purposes require a revision, whether mismatch cancels or rebases the item, and perform the check immediately before dispatch.

### Verification and settle pipeline

- **The mirrored-ticket ordering is still an unresolved alternative.** “Defer closure or compensate” materially changes prompts, tracker permissions, success detection, and recovery. **Fix:** choose one; preferably make Harmonic close the ticket only after verification and landing succeed.

- **Native auto-accept remains delegated to a future transition table.** This is a central product/state-machine decision rather than implementation detail. **Fix:** include the actual origin × verifier × verdict × merge-fate transition table in the plan.

- **The snapshot/cleanup language is internally inconsistent.** The pipeline records an immutable candidate OID and final snapshot, but cleanup still says “commit”; committing during cleanup can create a new unverified OID. **Fix:** create the candidate/final commit before verification/landing and make cleanup removal-only.

- **Verification in the mutable builder worktree is not truly bound to an OID.** A CAS before merge detects mutation afterward but does not ensure the command or critic observed a stable tree while running. **Fix:** run both command and critic in a detached temporary worktree created from the candidate OID.

- **Crash recovery for an in-progress command is underspecified.** A persisted `verification_attempt` does not show whether the command produced external side effects or whether it is safe to rerun. **Fix:** mark abandoned attempts inconclusive by default and require an explicitly idempotent verifier policy before automatic replay.

- **“Hardened against prompt injection” is not an implementable control.** A repository-reading critic is inherently exposed to adversarial text. **Fix:** specify concrete containment: trusted system prompt, untrusted-content delimiters, no credentials/tools, strict output schema, and document that verdict integrity remains probabilistic.

### Session lifecycle

- **Using the harness `sessionId` as the Session table primary key assumes global uniqueness across harnesses and installations.** **Fix:** give Session a Harmonic-generated ID and enforce uniqueness on `(harness, harnessSessionId)` where appropriate.

- **Persisting “mcp config” risks storing revoked run credentials.** **Fix:** persist only credential-free endpoint/config templates and mint credentials exclusively at load/dispatch time.

- **Worktree retention has no precise terminal condition.** Native `awaiting-review` may later be rejected into the same Session, so cleanup-after-review conflicts with “retain until Session is terminally done.” **Fix:** define Session states and explicitly retain or recreate the exact worktree through the human-rejection window.

- **Human review may outlive a lease expiry, but automatic expiry cannot safely release a dirty direct context or retained worktree.** **Fix:** expiry should mark a lease `suspect`; release only after proving no live owner and reconciling repository state, or through explicit operator disposition.

- **A summarized-session fallback needs a defined trustworthy summary source.** Asking the crashed or unavailable Session to summarize is impossible, while summarizing only prompts/events may omit filesystem and tool state. **Fix:** build the fallback reference deterministically from persisted transcript, run facts, candidate OID/status, tracker links, and structured failure context.

- **Compatibility policy is still only a noun.** It is unclear which model, adapter, permission, cwd, or configuration changes forbid load. **Fix:** define an explicit compatibility matrix and persisted incompatibility reason before implementing automatic reuse.

### Branch and repository coordination

- **Short repository-operation locks do not prevent operator Git activity.** A final CAS detects some ref changes but cannot undo a merge performed against a concurrently modified index or working tree. **Fix:** perform Harmonic land operations in a dedicated administrative worktree and update the target ref with an expected-old-OID operation.

- **Ref deltas cannot be attributed merely by observing the repository.** Concurrent worktree Runs and operators legitimately create or move refs during the same interval. **Fix:** track every Harmonic-owned ref mutation by lease/Run and treat all unattributed deltas as ambiguous rather than attempting deterministic recovery.

- **Agent re-merge still lacks a safe definition of success when deterministic recovery was already deemed ambiguous.** Rechecking HEAD/reachability can pass while unrelated commits were incorporated. **Fix:** require the corrective result to match an allowed commit set/tree-diff derived from recorded artifacts; otherwise Escalate.

- **The initial dirty-state policy is still presented as an alternative.** “Require clean, or snapshot and escalate” produces different admission behavior. **Fix:** choose the v1 rule; requiring clean direct contexts for afk Runs is the coherent option.

- **Submodules are called unsupported only for recovery, not admission or validation.** An afk Run can still modify them and pass top-level checks incorrectly. **Fix:** detect submodules/nested repositories before start and either reject afk direct execution or escalate on any recursive-state change.

### Guardrails and leases

- **Attempt-chain identity is not defined.** Native reattempts use linked Tasks, mirrored retries reuse a Task, and human rejects may create different flows; cumulative budgets cannot work without a stable chain key. **Fix:** add a persisted execution-chain ID and define exactly which retry, reject, resume, and self-heal operations inherit it.

- **Missing token data silently weakens an explicitly requested spend limit to wall-clock.** That is observable degradation, not enforcement. **Fix:** after a bounded telemetry grace period, trip to Escalation when a configured token/cost guard cannot be measured.

- **The hard tool timeout and overall wall-clock guard can race and emit different terminal reasons.** **Fix:** route both through the same fact coordinator and define which reason/evidence is primary when thresholds cross together.

- **Lease heartbeat authority is unspecified.** A paused event loop, long verification command, or loaded Session without a live harness could expire despite valid ownership. **Fix:** heartbeat from the pipeline coordinator, not the harness/event stream, and use phase-specific TTLs with suspect-state reconciliation.

These are narrower than the Round-1 problems, but they are material: the plan still postpones its actual state machine and leaves critical lifecycle choices unresolved. The next revision should lock those decisions rather than naming them as first implementation tasks.

VERDICT: REVISE
### Claude's response (Round 2)
Accepted; v3 LOCKS the deferred decisions rather than naming them as impl tasks:
- Spine: explicit Run phase machine (executing→validating→verifying→landing→review→terminal),
  execution-outcome separated from terminal disposition; terminal disposition computed by a
  coordinator transaction over append-only run_facts with fixed precedence + cutoff (not a CAS race);
  turn_queue lifecycle with durable claim/lease/idempotency-key/boundRevision semantics;
  Work Context lease heartbeat from the coordinator, phase TTLs, expiry→suspect (not release).
- A: mandatory wall-clock bound; snapshot config+prices; unmeasurable guard beyond grace → trip
  (enforcement not degradation); persisted Execution Chain threads cumulative budget across
  reattempt/retry/reject/resume/self-heal; tool-timeout + wall-clock both via coordinator.
- B: candidate commit in validating; verify in a DETACHED temp worktree at the OID; critic read-only
  structured verdict + injection containment (documented probabilistic); builder-heals + full re-verify;
  inconclusive→escalate; crash mid-verify→inconclusive unless idempotent; agentReview = authz migration;
  explicit native auto-accept transition TABLE; mirrored close ONLY after verify+land (compensating reopen).
- C: Harmonic-generated Session PK unique on (harness,harnessSessionId); credential-free MCP templates,
  mint at load; compatibility MATRIX for resume eligibility; deterministic summarized-fallback source;
  Session states + worktree retained through rejection window; keepalive dropped.
- D: clean-direct-context required (locked); detached-HEAD + submodule admission rejects; owned-ref
  tracking, unattributed=ambiguous; land in admin worktree + expected-old-OID CAS; agent re-merge success
  = match allowed commit-set/tree-diff else escalate.
REJECTED: dropping agent re-merge entirely (kept bounded per operator, now with concrete success def).

## Round 3 — Codex (VERDICT: REVISE)

V3 resolves most prior issues, but several material state-machine and irreversible-side-effect flaws remain.

- **Native human-review ordering is wrong.** `landing → review` lands the result before the human accepts it, contradicting the transition table. **Fix:** branch the graph: native human-gated Runs use `verifying → review → landing → terminal`; mirrored and auto-accepted Runs use `verifying → landing → terminal`.

- **Self-heal bypasses branch validation.** A mutating builder turn can switch branches, create refs, or introduce submodules before producing the next candidate OID. **Fix:** route every mutating corrective turn back through `validating → candidate snapshot → verifying`.

- **Non-idempotent ACP turn recovery remains unsafe.** Marking an ambiguous `in_flight` turn failed and “re-deriving” it can repeat filesystem or external tool mutations. **Fix:** reconcile transcript, Session, repository, and external state; if execution cannot be proven, Escalate rather than automatically dispatching another mutating turn.

- **Not every queued turn has a phase precondition.** A delayed continue, steer, or crash-recovery turn could run after agent completion while validation or verification is underway. **Fix:** bind every item to Run ID, expected phase/generation, and—where mutating—expected workspace OID; atomically cancel outstanding execution turns when execution closes.

- **The cutoff rule remains unsafe around irreversible landing.** A cancellation or guardrail fact can arrive after target-ref update, PR creation, or ticket closure but before terminal recording. **Fix:** define landing as a journaled non-interruptible operation with intent/result records, explicit cancellation boundaries, and reconciliation before terminal disposition.

- **Landing is not crash-idempotent.** A crash after updating a ref or creating a PR but before recording success can make replay report conflict or duplicate external effects. **Fix:** persist operation intent plus expected result/idempotency identity before each side effect, then reconcile Git/PR/ticket state on recovery before retrying.

- **Administrative-worktree ref CAS can desynchronize a checked-out target branch.** Updating the target ref through plumbing leaves the base/direct worktree’s index and files representing the old commit. **Fix:** update a checked-out target only under an exclusive clean lease with a coherent checkout/reset, or require it not be checked out and use PR/manual landing.

- **Direct-mode candidate creation is underspecified.** Creating the candidate commit on the live target branch would expose unverified work before `landing`. **Fix:** construct the candidate using a private Harmonic ref or `commit-tree` without moving the intended target ref.

- **Mirrored completion still conflicts with current ticket-driven success.** An agent may close the ticket before verification, and compensation is specified only for verification failure—not branch violations, guardrails, landing failures, cancellation, or process death. **Fix:** make `finish_task` the execution-complete signal and either prevent agent ticket closure or reopen premature closure for every non-success disposition.

- **The transition table omits mirrored Runs with no verifier.** `mirrored | any | pass` does not cover a configuration that produces no verdict. **Fix:** add an explicit `mirrored | none | —` row or reject verifier-free mirrored configuration.

- **Worktree cleanup has conflicting owners.** Section 0 removes the worktree when the Run becomes terminal, while Unit C retains it until Session retirement for reject continuation. **Fix:** make Session retirement the sole owner of builder-worktree removal and transactionally transfer the Work Context lease between Runs sharing that Session.

- **Lease identity is still unsafe for direct mode.** A key containing `{path, branch}` can permit two leases for the same physical directory on different branches, even though one checkout cannot host both simultaneously. **Fix:** key direct-mode leases by canonical working-directory identity alone; reserve path-plus-branch identity for isolated worktrees.

- **Session retirement and the human-rejection window lack a deadline and transition trigger.** An accepted, abandoned, or never-reviewed Session can retain its worktree indefinitely. **Fix:** define configurable retirement transitions for accept, reject-continuation, review abandonment, operator disposition, and retention expiry.

These are implementation-significant, especially the reversed native-review phase, self-heal validation bypass, ambiguous turn replay, and non-idempotent landing recovery.

VERDICT: REVISE
### Claude's response (Round 3)
Accepted all 13; v4 fixes: (1) phase graph branches by gate — native human = ...→review→landing;
mirrored/auto-accept = ...→landing. (2) self-heal/corrective mutating turns re-enter validating→snapshot→verifying.
(3) ambiguous in_flight turn recovery = reconcile all state, Escalate if execution unprovable (no blind replay).
(4) every turn bound to {runId, expectedPhase/generation, expectedOID}; execution-close cancels outstanding turns.
(5) landing = journaled non-interruptible op; cutoff evaluated post-landing. (6) landing crash-idempotent via
landing_journal intent+expected-result before each side effect, reconcile git/PR/ticket on recovery.
(7) checked-out target land only under exclusive clean lease w/ coherent reset, else PR/manual. (8) direct-mode
candidate via commit-tree/private ref, never moves target. (9) mirrored: finish_task=execution-complete; close
only after verify+land; reopen/escalate on EVERY non-success disposition. (10) added mirrored|none|finish_task row.
(11) Session retirement is sole owner of worktree removal. (12) direct-mode lease keyed by working-dir identity
alone; worktree by {path,branch}. (13) Session retirement transitions + deadlines defined.

## Round 4 — Codex (VERDICT: REVISE)

V4 closes the Round-3 issues, but a few material contradictions remain.

- **Late cancellation still conflicts with irreversible landing.** A cancel arriving after a ref update but before the post-landing cutoff wins precedence, yielding a cancelled Run whose code is already landed. **Fix:** persist a “point of no cancellation” before the first irreversible effect; later cancellation facts remain audit events but cannot alter disposition.

- **Direct mode still lets the agent move the live target ref during execution.** `commit-tree` freezes the resulting tree but cannot prevent an agent commit/reset from exposing unverified work beforehand. **Fix:** run direct-mode afk execution on a detached/private Harmonic ref, or reject any target-ref movement and restore it safely before proceeding.

- **Direct-mode cleanliness is internally inconsistent.** After agent edits, the checked-out target is dirty, but landing requires an exclusive clean lease; resetting it risks losing the exact workspace needed for review rejection or self-heal. **Fix:** snapshot onto the private ref, restore the target checkout coherently, and define how the candidate is rematerialized for later corrective turns.

- **Session retirement “on Accept” is premature.** Native Accept precedes landing, so retirement could remove the builder worktree before a failed landing is diagnosed or recovered. **Fix:** retire after successful landing and terminal success; failed/escalated Runs retain or archive evidence until operator disposition.

- **ACP load-time replay is absent from the state model.** Historical `session/update` notifications emitted during `session/load` could be stored as current activity, double-count usage, or trigger progress detection. **Fix:** tag/quarantine updates until load completes, deduplicate them into Session history, and exclude them from current-turn usage, facts, and guardrails.

- **`additionalDirectories` is sent without capability gating.** Optional or older ACP implementations may reject the load request. **Fix:** include it only when advertised; if additional roots are required but unsupported, mark the Session incompatible.

- **Wall-clock accounting across human review is undefined.** The mandatory afk Run timeout could expire while awaiting a person, then compete with non-interruptible landing. **Fix:** scope execution budgets to executing/validating/verifying, use the review SLA during review, and give landing its own operation timeout and recovery policy.

- **Open-PR Merge Fate does not fit “land, then close ticket.”** Creating a PR is not landing the change, and closing the ticket immediately removes the existing merge-driven completion behavior. **Fix:** define outcomes per Merge Fate: auto-merge may close after merge; open-PR keeps the ticket open or links closure to PR merge; artifact uses its own completion rule.

VERDICT: REVISE
### Claude's response (Round 4)
Accepted all 8; v5: (1) persisted point-of-no-cancellation before first irreversible landing effect;
later cancels are audit-only. (2) direct-mode afk executes with HEAD detached on a private Harmonic ref;
target restored at settle; candidate rematerialized from private ref. (3) direct cleanliness resolved via
private-ref snapshot + coherent restore. (4) Session retirement after successful landing+terminal (not on
Accept); failed/escalated retain evidence. (5) load-time replay quarantined (deduped to history, excluded
from current-turn usage/facts/guardrails). (6) additionalDirectories only when advertised, else incompatible.
(7) phase-scoped budgets: execution budget = executing/validating/verifying; review = SLA; landing = own timeout.
(8) Merge-Fate-specific mirrored completion: auto-merge closes after merge; open-PR keeps ticket open (closure
links to PR merge); artifact no auto-close.

## Round 5 — Codex (VERDICT: REVISE — MAX_ROUNDS reached)

V5 is close, but three implementation-critical ambiguities remain.

- **Candidate snapshot construction is underspecified.** `commit-tree` consumes an existing tree; using the live index can omit unstaged/untracked changes or preserve agent-controlled staging, and the parent is undefined. **Fix:** use a private temporary index seeded from the validated base, apply `add -A` from the leased workspace, `write-tree`, then `commit-tree` with the validated base parent and CAS the private ref.

- **A detached verification worktree is not immutable during verification.** Test commands commonly generate files, may alter shared refs through the common Git directory, and can make a subsequent critic observe something other than the candidate. **Fix:** use a fresh disposable verification checkout per mechanism, restrict credentials/external writes, and verify/reset tree and ref fingerprints before and after each verifier.

- **Turn revision binding remains ambiguous for agent-capable initial, continue, and crash-recovery turns.** Phase/generation plus HEAD OID may not detect changed staged, unstaged, or untracked workspace content. **Fix:** bind every agent-capable turn to an atomically checked workspace generation plus HEAD/tree/dirty fingerprint; exempt only genuinely read-only turns.

- **Review-SLA expiry defines retirement but not Run disposition.** The Session could retire and remove its worktree while the Run remains persisted in `review`. **Fix:** make SLA expiry a `run_fact` that atomically transitions the Run to an explicit terminal disposition, archives evidence, resolves the lease, and then retires the Session.

- **Open-PR completion lacks durable post-terminal ownership.** “Closure links to PR merge” does not say whether the tracker handles it or Harmonic must observe and close exactly once. **Fix:** require provider-native close-on-merge linkage or add a journaled reconciliation operation keyed by PR and ticket identity.

VERDICT: REVISE
### Outcome: loop capped at 5 rounds. Remaining items are implementation-spec-grade, all accepted (not contested). Critique shrank 20K→8.9K→4.7K→2.9K→2.0K bytes across rounds.
