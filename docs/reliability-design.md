# Harmonic reliability design — v5 (after a 5-round Codex adversarial review)

*Four units (Guardrails, Verification, Session/resume, branch enforcement) + a
Work Context lease, on a shared coordination spine. It went through a 5-round Codex
adversarial review; the converged result locks the phase state machine, the
coordinator / turn-queue / lease semantics, and the previously-deferred decisions.
The five remaining items (recorded at the end) are implementation-spec detail.*

## The unifying frame

A Run today ends only by agent signal, process death, or operator action. This
design adds **Harmonic acting on a Run it watches**, and makes the ACP **Session**
a durable first-class resource. New nouns: **Guardrail**, **Session**, **Work
Context** (+ lease), **Execution Chain**. UX stays invisible-until-it-fires.

---

## 0. Coordination spine

### 0.1 Persisted state (authoritative)
Tables: `sessions`, `execution_chains`, `work_context_leases`, `turn_queue`,
`verification_attempts`, `guardrail_events`, `landing_journal`, and append-only
`run_facts`. Task lifecycle states are a projection of these, never the source of
coordination truth.

### 0.2 The Run phase machine (locked — branches by gate)
Execution outcome is separate from terminal disposition. The graph **branches on
whether a human gate applies**:
- **Native, human-gated:** `executing → validating → verifying → review → landing → terminal`
  — the human Accepts a **verified but not-yet-landed** result; landing happens
  *after* Accept.
- **Mirrored / native auto-accept:** `executing → validating → verifying → landing → terminal`
  — no human gate.
Each phase is persisted and independently crash-recoverable. Worktree removal is
owned by **Session retirement (§C)**, not by reaching `terminal`.

### 0.3 Terminal disposition + journaled landing (locked)
- Every ending signal is an append-only `run_fact` with a monotonic seq. At each
  phase decision point (**cutoff**) the coordinator computes the disposition by
  fixed precedence: `operator-cancel > operator-accept > escalate > branch-violation > verify-fail
  > guardrail-trip > agent-finish/unresolved > process-death`. `operator-accept` overrides automatic `escalate` on re-parked runs (issue #191), ranked below cancel to preserve pre-PONC safety.
- **Landing is a journaled, non-interruptible operation.** Before each external
  side effect (target-ref update, PR creation, ticket close) the coordinator
  writes a `landing_journal` intent with an **expected-result / idempotency
  identity**; the effect is applied; the result is recorded. A persisted **point of no
  cancellation** is written before the first irreversible effect: facts arriving
  *before* it win by precedence; a cancel/guardrail fact arriving *after* it stays
  an audit event but **cannot alter the disposition** — the code is landing
  regardless. On crash, recovery **reconciles git/PR/ticket state
  against the journal before any retry**, so a half-applied landing never
  duplicates or false-conflicts.

### 0.4 One serialized per-Session turn queue (locked)
Every turn is a `turn_queue` row; **single-flight per Session**:
```
queued → claimed(lease+heartbeat) → in_flight(idempotency_key, sent_at) → done | failed
```
- Every item is bound to `{runId, expectedPhase/generation, purpose, budget}`, and
  mutating items additionally to `expectedWorkspaceOID`. An item whose precondition
  no longer holds (wrong phase/generation/OID) is **cancelled, not run** — so a
  delayed continue/steer/recovery turn can never fire after execution has closed.
  Closing execution **atomically cancels outstanding execution turns.**
- **Mutating corrective turns (self-heal, agent re-merge) re-enter the pipeline at
  `validating`** (→ candidate snapshot → verifying) — they never skip branch
  validation, because a builder turn can create branches/refs/submodules.
- **Ambiguous `in_flight` at crash is not blindly replayed.** Recovery reconciles
  transcript, Session, repository, and external state; if the turn's execution
  cannot be *proven* complete-or-not, the Run **Escalates** rather than dispatching
  another mutating turn. `boundRevision` is required for mutating turns (checked
  immediately before dispatch), absent for initial/continue/crash-recovery.

### 0.5 The Work Context lease (locked)
- **Key by isolation mode**: **direct** leases key on **canonical working-directory
  identity alone** (one checkout can't host two branches, so path+branch would
  wrongly admit two); **worktree** leases key on `{path, branch}`.
- Acquired before `ready→running` via a DB unique constraint; enforced in
  `Runner.start`/`launchClaimed`. **Heartbeat from the pipeline coordinator**
  (not the harness), phase-specific TTLs. **Expiry → `suspect`, never auto-
  release** (a dirty context / retained worktree is released only after proving no
  live owner, or by operator disposition). Operator supersede/unlock + queue
  diagnostics prevent starvation; boot reconciles leases.
- A lease is **transactionally transferred** between successive Runs that share one
  Session (retry/reject continuation), so the builder worktree has one owner.

---

## Unit A — Run Guardrails

- Trip → a `run_fact`, resolved by the coordinator (§0.3).
- **Mandatory wall-clock bound** per afk Run; tokens/cost optional. Config + price
  table snapshotted at Run start. **Budgets are phase-scoped**: the execution budget
  covers `executing/validating/verifying` only; **review** runs on the review SLA
  (not the execution clock); **landing** has its own operation timeout + recovery —
  so an afk timeout can't expire while awaiting a human or fight a non-interruptible
  land. cost→token fallback; unpriced + no token limit =
  rejected config; a configured guard that **cannot be measured** past a grace
  period **trips to Escalation** (enforcement, not silent degradation).
- **Execution Chain** (`execution_chains.id`) threads cumulative budget across
  reattempt / mirrored retry / human-reject continue / crash-resume / every
  self-heal turn; per-Run budgets also exist.
- **Progress detector** off by default until trace-validated; idle detection
  **suspends while a tool call is outstanding**, paired with a hard tool-timeout.
  Tool-timeout and wall-clock both emit `run_facts`; precedence picks the primary.
- Persist structured `guardrail_events`; the card reason derives from them.

## Unit B — Verification

Runs in `verifying` against a **frozen candidate OID**:

- **Candidate creation (locked, safe for direct mode):** `validating` builds the
  candidate with `git commit-tree` / a **private Harmonic ref** — it **never moves
  the intended target ref**, so unverified work is not exposed on the live branch.
- Verification runs in a **detached temporary worktree checked out at the candidate
  OID** (command and critic both see a stable tree).
- **Command**: argv-based, explicit cwd/env, timeout, output cap, cancellation;
  exit-code→verdict mapping; infra failure → inconclusive. Built in #135
  (`src/verification/command-verifier.ts`), wired into the Runner's `verifying`
  phase; each attempt is persisted to the verification-attempt log at the frozen
  candidate OID before its verdict is combined. Exit-code → verdict table
  (`exitCodeToVerdict`, enforced):
  | command result | verdict |
  |---|---|
  | exit code 0 | pass |
  | exit code non-zero (1–255) | fail |
  | spawn error (missing command / EACCES) | inconclusive |
  | timeout (killed after `timeoutSeconds`) | inconclusive |
  | cancelled (AbortSignal, e.g. shutdown) | inconclusive |
  | killed by signal / no exit code | inconclusive |
  | candidate checkout failure (bad OID, git/FS) | inconclusive |
  Unlike the critic, a command is *expected* to write to its disposable
  detached checkout (a build/test writes artifacts), so the before/after
  fingerprint `mutated` flag is recorded for audit but never overrides the
  verdict — the detached, disposable, removed-after worktree is the containment.
- **Critic**: read-only, no mutating tools/creds, bound to the OID; structured
  schema-validated verdict; malformed/missing → inconclusive; injection
  containment (trusted system prompt + delimited untrusted content + no tools/creds
  + strict schema); integrity documented as probabilistic.
- **Combination**: all configured verifiers must pass; the **full suite reruns**
  after any self-heal. **Self-heal routes through the builder Session as a mutating
  turn → re-enters `validating` (§0.4)**; only actionable fails heal; inconclusive
  Escalates; bounded + charged to the Execution Chain.
- Crash mid-verify → attempt marked inconclusive; replay only if the verifier is
  declared idempotent.
- **`agentReview` replacement is an authorization migration** (deprecate the
  run-scoped `accept_task`/`reject_task` tools + scoped-key policy + config
  migration).
- **Transition table (locked):**
  | origin | verifier | verdict | outcome |
  |---|---|---|---|
  | native | none | — | `review` (human), then land on Accept |
  | native | present, auto-accept off | pass | `review` (human), then land on Accept |
  | native | present, auto-accept on | pass | land (no human gate) |
  | native | present | fail (post-heal) / inconclusive | Escalate |
  | mirrored | none | `finish_task` | complete per Merge Fate (below) |
  | mirrored | present | pass | complete per Merge Fate (below) |
  | mirrored | present | fail / inconclusive | Escalate; ticket not closed |
- **Mirrored completion (locked):** `finish_task` is the **execution-complete**
  signal; Harmonic closes the ticket **only after verify + land succeed**. The
  agent's skill is prevented from closing the ticket itself (or a premature closure
  is **reopened + Escalated**) on **every** non-success disposition — branch
  violation, guardrail trip, landing failure, cancel, or process death, not just
  verify-fail. **Completion is Merge-Fate-specific:** *auto-merge* → merge, then
  Harmonic closes the ticket; *open-PR* → create the PR and **leave the ticket
  open** (closure links to the PR's own merge — creating a PR is not landing);
  *artifact* → leave the branch, no auto-close.
- **Direct mode**: no auto-verify/accept on a dirty or concurrently-editable
  context; verification uses the detached temp worktree.

## Unit C — Session & resume

- **Session entity**: Harmonic-generated PK, unique on `(harness,
  harnessSessionId)`. Stores harness/model/cwd/work-context identity,
  **credential-free MCP templates** (creds minted at load/dispatch, never
  persisted), permission-mode, capabilitySnapshot, adapter/config version, status,
  `lastActiveAt`, `estimatedWarmUntil`, run bindings.
- **Session states + worktree ownership (locked):** `active → idle → retiring →
  retired`. **Session retirement is the sole owner of builder-worktree removal**
  (resolving the §0.2-vs-worktree conflict). Retirement transitions are defined
  with deadlines: on **successful landing + terminal success** (native — *after*
  Accept, since landing follows the human gate and can fail; a failed/escalated Run
  **retains/archives** evidence until operator disposition), on **reject-continuation
  timeout**, on **review abandonment** (SLA/expiry), on **operator disposition**, and
  on a **retention TTL** — so no accepted/abandoned Session retains its worktree
  indefinitely.
- **Cache warmth is a COST signal, not a correctness gate.** Resume eligibility =
  a **compatibility matrix** (same harness + compatible adapter/config version +
  same cwd/work-context identity + re-establishable permission mode; model change
  allowed but re-verified); incompatibility persists a reason and forces a new
  Session. Per-harness warm windows are cost estimates (Claude ~1h via
  `ENABLE_PROMPT_CACHING_1H`), never promises.
- **Resume = a new Run + a new prompt turn on a loaded Session**, after repo
  reconciliation — not process reattach. Load handshake per harness (verify
  `loadSession`; `session/load {sessionId, cwd, mcpServers}` plus
  `additionalDirectories` **only when advertised** — if required roots are
  unsupported, mark the Session incompatible; verify modes+model; rebind fresh creds;
  classified failure → one **summarized**-Session fallback, built **deterministically
  by Harmonic** from persisted `run_events` + `run_facts` + candidate OID/status +
  tracker links). **Load-time replay is quarantined**: the historical `session/update`
  stream a load emits is deduped into Session history and **excluded** from
  current-turn activity, usage, `run_facts`, and progress detection.
- **Human-reject dialog**: "continue full conversation (est. cost/latency shown)"
  vs "start condensed conversation" — not TTL-gated. Automated (warm) reject reuses
  silently. **Keepalive dropped in v1.**

## Unit D — Branch-contract enforcement

Contract: **Harmonic owns branching.** Enforced in `validating`, before landing.

- **Persist at start**: canonical repo identity, start branch, **start commit
  OID**, expected worktree path, dirty-state fingerprint. **Admission rejects** an
  afk **direct** Run on a **dirty** context or one containing **submodules/nested
  repos** (attribution/recursive-state unsupported); detached HEAD is rejected or
  requires an operator-selected landing branch (record the commit, never mis-record
  `HEAD`).
- **Direct-mode execution isolation (locked):** an afk **direct** Run executes with
  HEAD **detached onto a private Harmonic ref**, never the live target branch — so an
  agent commit/reset cannot expose unverified work on the target. The live target
  checkout is restored coherently at settle; the candidate is **rematerialized from
  the private ref** for any later corrective turn or review-reject continuation.
- **Owned-ref tracking**: every Harmonic ref mutation is tagged by lease/Run; at
  validation, **unattributed ref deltas are ambiguous** → never auto-recovered.
- **Landing (locked, crash-idempotent):** performed in a **dedicated administrative
  worktree**; the target ref is updated with an **expected-old-OID CAS**, journaled
  per §0.3. **If the target branch is checked out** (direct mode), landing runs
  only under an **exclusive clean lease with a coherent checkout/reset**, otherwise
  it requires the target **not** be checked out and falls back to **PR / manual**
  landing — never a plumbing ref-update that desyncs a live index/worktree.
- **Recovery**: deterministic git recovery from recorded OIDs/ref-deltas when
  unambiguous. **Agent re-merge** is a bounded fallback only when deterministic
  recovery is ambiguous; success is defined as the corrective result **matching an
  allowed commit-set / tree-diff** derived from recorded artifacts — anything else
  Escalates, no second mutating turn. Lease held throughout; start OID re-verified
  before mutation; the turn re-enters `validating` (§0.4).
- **Escalation evidence**: structured branch-violation report; worktree/refs
  retained until operator disposition.

---

## What I rejected or deferred (arbiter notes)

- **Drop agent re-merge entirely (Codex).** *Partially rejected* per operator
  decision — bounded fallback behind deterministic recovery, with a concrete
  success definition and lease guards. Deterministic-only stays the safer option.
- **"Runner has no steer queue" (Codex R1).** Steer exists (ADR-0018); adopted the
  deeper point — one durable turn queue for all producers (§0.4).

## Scope & status

The state machine (§0.2), disposition + journaled landing (§0.3), turn-queue
preconditions (§0.4), lease keying/ownership (§0.5), the verification transition
table + mirrored reconciliation, the Session lifecycle, and the branch/landing
idempotency rules are **locked here**. Remaining implementation artifacts are the
concrete column lists and per-phase transition tables. ADRs 0019–0023 will be
reconciled to this once the review converges.

## Round-5 accepted refinements (the first implementation tasks)

The Codex loop capped at 5 rounds still REVISE, but the five remaining items are
precise implementation-level details — all accepted, none contested:

1. **Candidate snapshot, hermetic:** a private temp index seeded from the validated
   base, `add -A` from the leased workspace, `write-tree`, then `commit-tree` with
   the validated base as parent, CAS the private ref — never the agent-controlled
   live index (which could omit untracked/unstaged changes or preserve agent
   staging).
2. **Verification isolation:** a fresh disposable checkout **per verifier
   mechanism**, restricted credentials/external writes, and tree+ref fingerprints
   checked before/after each verifier (a test run mutates files and can touch shared
   refs via the common git dir).
3. **Turn binding:** bind every **agent-capable** turn (initial/continue/crash-
   recovery included) to an atomically-checked workspace generation + HEAD/tree/dirty
   fingerprint; exempt only genuinely read-only turns.
4. **Review-SLA expiry** is a `run_fact` that atomically moves the Run to an explicit
   **terminal disposition** + archives evidence + resolves the lease, *then* retires
   the Session — retirement never orphans a Run stuck in `review`.
5. **Open-PR completion ownership:** require provider-native close-on-merge linkage,
   or a **journaled reconciliation keyed by PR + ticket identity** that closes the
   ticket exactly once (creating a PR is not landing).
