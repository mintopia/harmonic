# Harmonic reliability design — v2 (revised after Codex Round 1)

*Four units (Guardrails, Verification, Session/resume, branch enforcement) + a
Work Context rule. Round-1 adversarial review (Codex) showed the units can't be
made race-safe by bolting checks onto `settle`; they need one shared, persisted
coordination spine. This revision adds that spine and folds in the fixes.*

## The unifying frame

A Run today ends only by agent signal (`finish_task`/`escalate_task`), process
death, or operator action. This design adds a fourth actor — **Harmonic acting
on a Run it watches** — and makes the ACP **Session** a first-class, durable
resource. New domain nouns: **Guardrail** (a watched limit that trips),
**Session**, **Work Context** (+ its lease). UX stays invisible-until-it-fires:
a small Settings group; a reason in the card's escalated-tag slot; one reject
dialog.

---

## 0. Coordination spine (the Round-1 fix — everything below rests on this)

The four units share overlapping timers, prompts, repo mutations, and recovery
paths. They are made safe by **five shared mechanisms**, all durable:

1. **Persisted coordination state — nothing inferred from volatile Task state.**
   New tables: `sessions`, `work_context_leases`, `verification_attempts`,
   `guardrail_events`, and append-only `run_facts` (durable signals). The exact
   columns + state-transition tables are the first implementation deliverable.

2. **One serialized per-Session turn queue.** *Every* prompt turn — initial,
   continue-nudge, steer, self-heal, corrective-merge, crash-recovery — is a
   queued item `{purpose, budget, boundRevision}`. **Single-flight: exactly one
   turn in flight per Session.** This removes the "multiple producers prompt the
   same Session concurrently" races (steer vs continue vs self-heal).

3. **A single atomic terminal decision.** A Run settles exactly once via one
   compare-and-set with explicit **precedence**:
   `operator-cancel > escalate > guardrail-trip > agent-finish/unresolved >
   process-death`. Idempotent; a late/racing signal no-ops. Replaces today's
   ad-hoc settle branches that a budget timer could race against `finish_task`
   or auto-merge.

4. **The explicit settle pipeline (replaces "at settle").** Ordered, with
   cleanup **last** and everything bound to a recorded OID:
   `agent turn → branch-contract validation → candidate snapshot (record tree/commit OID)
   → verification + self-heal loop (against that OID) → final snapshot
   → merge/review → cleanup (commit / remove worktree)`.
   Today Runner kills the harness, commits, and removes the worktree *before*
   settle logic — so validation and verification must move ahead of cleanup.

5. **The Work Context lease (durable).** Keyed by canonical repo identity
   `{repoRoot, worktree path/branch}`, holding `{phase, ownerRunId, heartbeat,
   expiry, supersede}`. Acquired before `ready→running` via a DB
   unique-constraint/CAS, enforced centrally in `Runner.start`/`launchClaimed`
   (not only `pickNext`, which manual/API/multi-process starts bypass), and
   reconciled at boot.

---

## Unit A — Run Guardrails

A Guardrail watches a running Run; a trip flows into the **single atomic terminal
decision** (§0.3) → stop + Escalate with a reason.

- **Every afk Run has ≥1 hard bound.** Wall-clock is the mandatory default
  (resolves the "always guards" vs "any subset" contradiction). Optional
  dimensions: tokens, cost.
- **Budget config is snapshotted at Run start** (effective thresholds + price
  table) — no mid-run reprice changes the outcome.
- **cost→token fallback**: an unpriced model with **no** configured token limit
  is a **rejected configuration** (don't silently fall through to wall-clock
  only when the operator asked to cap spend).
- **Token enforcement is best-effort and lagging** (usage sampled from harness
  logs). Spec required: authoritative-enough counters, polling cadence, an
  accepted **overshoot tolerance**, missing-data behavior (degrade to the
  wall-clock bound), and **cumulative accounting across continued/self-heal
  turns**.
- **Progress/stall detector**: off by default until validated against **recorded
  real event traces**. Deterministic features, persisted detector state. Crucially
  it **suspends idle detection while a tool call is outstanding** (ACP emits no
  events during a long command) and pairs with a separate generous hard
  tool-timeout for the no-events case — otherwise long tools false-positive.
- **Nudge = a queued turn** (§0.2), never a concurrent prompt.
- **Budget scope**: separate **per-Run** and **per-Task/attempt-chain** budgets;
  retries and self-heals charge the attempt-chain budget so an auto-retry can't
  reset-and-bypass the ceiling.
- **Observability**: persist structured `guardrail_events`
  (limit/observed/threshold/evidence/nudge-outcome/config-source); the card
  reason is derived from them.

## Unit B — Verification

Runs **inside the settle pipeline** (§0.4): validate → snapshot → verify against
the **recorded OID** → self-heal → re-snapshot. The verdict binds to an
immutable revision, re-checked (CAS) immediately before merge/accept.

- **Mechanisms**: a **command** and/or an **agent** critic, global default +
  per-Workspace override.
- **Command**: argv-based, explicit cwd/env, timeout, output cap, cancellation,
  documented exit-code→verdict mapping; infrastructure failure ≠ test failure
  (infra → *inconclusive*).
- **Agent critic**: **read-only, no mutating MCP tools or credentials**, bound to
  the candidate revision; emits a **structured, schema-validated verdict** (not
  parsed prose); malformed/missing → *inconclusive*; hardened against repo
  prompt-injection.
- **Combination**: every configured verifier must pass; any fail/inconclusive
  blocks (truth table in the impl spec).
- **Verdicts**: pass / fail / inconclusive. **Actionable fail → self-heal**;
  **inconclusive → Escalate immediately with its classified cause** (don't
  self-heal an infra outage or a missing command).
- **Self-heal** is routed into the **builder Session** (not the critic) as one
  serialized corrective turn; after **any** heal edit, the **full** verifier
  suite reruns against the new tree; capped; every heal/verify turn + command
  duration charges the attempt-chain guardrail budget.
- **Durable state**: `verification_attempts {mechanism, inputOID, verdict,
  output, phase}` so a crash mid-verify recovers safely.
- **Replacing `agentReview` is an authorization migration**, not just config:
  separately specify deprecation/removal of the `accept_task`/`reject_task` MCP
  tools for run-scoped keys, the scoped-key HTTP policy, config migration, and
  existing-client behavior. Verify-agent *pass → auto-accept* is the replacement.
- **Native auto-accept** needs an explicit **origin × verification-config ×
  merge-fate transition table**: native bypasses human review **only** when a
  verify-agent is configured to auto-accept on pass; otherwise pass →
  `awaiting-review` as today.
- **Mirrored ordering** (ADR-0011 interaction): **defer ticket closure until
  verification passes**, or define a compensating reopen/escalate — never leave a
  closed ticket for code that then fails verification.
- **Direct mode**: no automatic verification/acceptance on a dirty or
  concurrently-editable context; verify against an immutable temporary worktree
  instead.

## Unit C — Session & resume

- **Session entity (durable)**: `{id = harness sessionId, harness, model, cwd /
  work-context identity, mcp config, permission-mode, capabilitySnapshot,
  adapter/config version, status, lastActiveAt, estimatedWarmUntil, run
  bindings}`. `sessionId` alone is **not** enough to reload.
- **Cache warmth is a COST signal, not a correctness gate.** `session/load`
  restores history whether warm or cold. Resume **eligibility** = session
  compatibility + operator policy; warmth only informs cost/latency. Store
  `lastActiveAt` + a clearly-named `estimatedWarmUntil` — **never promise
  warm**. Per-harness windows are **configurable cost heuristics** with
  conservative defaults, recording the source/version they came from (Claude ~1h
  on a subscription via `ENABLE_PROMPT_CACHING_1H`; Codex/Copilot short — all
  estimates, not protocol guarantees).
- **Resume = a new Run + a new prompt turn on a loaded Session**, after
  repository reconciliation — **not** reattaching a dead process, outstanding
  JSON-RPC request, or half-executed tool. Uses an explicit crash-recovery prompt
  with idempotency checks.
- **Load handshake, per harness**: check `loadSession` is advertised; call
  `session/load {sessionId, cwd, mcpServers, additionalDirectories}`; verify
  returned modes + model; reset mode; **rebind fresh MCP credentials** (the old
  run-scoped key is revoked at finalize/boot); a classified load failure falls
  back **once** to a new summarized Session (no unbounded retry).
- **Worktree resume**: settle deletes the worktree today, but a loaded Session
  was created against that cwd. v1: **retain the worktree until the Session is
  terminally done** (tied to the Work Context lease); if cwd identity can't be
  restored, deliberately start a **fresh** Session.
- **Durable signals**: persist `agentFinished`/`escalateReason` as append-only
  `run_facts`; derive recovery disposition (committed-before-crash → settle; not
  committed → fresh turn). Volatile request state is **not** resumable.
- **Human-reject dialog** reframed away from TTL: **"continue full conversation
  (loads full context — estimated cost/latency shown)"** vs **"start condensed
  conversation."** A cold load is still valid; neither option is disabled by
  elapsed time. Automated reject (verify-agent, warm) reuses silently.
- **Keepalive is DROPPED in v1.** A prompt needs process + load + a full turn
  (not a client-side ping), and an agent turn is not side-effect-free. Revisit
  only if a harness exposes a side-effect-free cache-touch primitive, and then
  only as a leased, budgeted, hard-expiry scheduled job.

## Unit D — Branch-contract enforcement

Contract: **Harmonic owns branching; the agent never creates/switches branches.**
Enforced by detection, positioned **before** commit/worktree-removal (§0.4).

- **Persist at start**: repo identity, start branch, **start commit OID**,
  expected worktree path, initial dirty-state fingerprint — not just a branch
  name (a name can be reset/force-moved/deleted while unchanged).
- **Concrete invariant** (replaces "no stray branch holds the work"): expected
  HEAD, worktree association, recorded start OID, ref-deltas observed during the
  Run, and commit reachability from the intended branch.
- **Detached HEAD**: reject, or require an operator-selected landing branch
  (record the commit).
- **Direct-mode dirty tree**: require a **clean** direct Work Context for afk, or
  snapshot the initial index and **Escalate rather than auto-recover** when dirty
  (agent vs pre-existing changes are unattributable).
- **Submodules / nested repos**: **unsupported** for automatic branch recovery in
  v1 (recursive state verification deferred).
- **Recovery order**: prefer **deterministic git recovery** from recorded
  OIDs/ref-deltas when unambiguous. The **agent re-merge** (your chosen path) is
  retained only as a **bounded fallback** when deterministic recovery is
  ambiguous — and then: hold the Work Context lease through validation+recovery,
  keep the exact workspace alive, re-verify the start OID immediately before
  mutation, run it as a single queued turn (cap 1), and **re-validate the
  invariant afterward**; if unsatisfied → preserve artifacts + Escalate (no
  second mutating turn).
- **Land under a repo lock** with a final CAS on the relevant refs (HEAD may
  change between check and merge).
- **Escalation evidence**: persist a structured branch-violation report; retain
  the worktree/refs until operator disposition.

## Work Context house rule (revised to a lease)

- A **durable lease** (§0.5), not just a scheduler predicate. Enforced in
  `Runner.start`/`launchClaimed` + a DB unique-constraint, so manual/API/
  multi-process starts can't bypass it.
- **Direct mode**: a working-directory lease acquired before `ready→running`;
  HEAD read + persisted **under the lease** (it's unstable otherwise — an
  operator or another Run can switch it between check and spawn).
- **Worktree mode**: the "≤1 per context" rule is **vacuous** (each Run gets a
  unique branch/dir, and the prospective context isn't even known pre-Run since
  the branch embeds `run.id`). Replace it there with **short repository-operation
  locks** around worktree create / merge / remove to protect the shared base
  repo.
- **Anti-starvation**: lease **expiry** + operator **supersede/unlock** controls
  + queue diagnostics that expose the blocking Task/Run and wait duration (an
  abandoned native review must not starve the context forever). Boot reconciles
  leases; a crashed verify/review is recoverable or expirable. Schedule by
  eligible context and surface skipped-reasons.

---

## What I rejected or deferred (arbiter notes)

- **Codex: drop agent re-merge entirely (Unit D).** *Partially rejected.* The
  operator explicitly chose agent re-merge. Kept, but demoted **behind**
  deterministic git recovery and wrapped in the safety constraints above
  (lease-held, OID-reverified, invariant-rechecked, no second mutating turn).
  Flagged for operator sign-off — deterministic-only is the safer alternative.
- **Codex: "Runner has no steer queue."** Factually, steer *is* implemented
  (ADR-0018) with an in-memory queue. Adopted the deeper, correct point: unify
  **all** turn producers through one durable serialized queue (§0.2).

## Scope

This is a design/decision spec. The persisted schema (`sessions`,
`work_context_leases`, `verification_attempts`, `guardrail_events`, `run_facts`)
and the full state-transition tables are the **first implementation
deliverable** — but the coordination spine (§0) is now explicit so the four units
share one state machine instead of racing around `settle`. ADRs 0019–0023 will be
updated to match once this converges.
