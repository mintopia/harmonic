# Issue #138 — verification(native): review-before-land + transition table + auto-accept

Child of #109. Blocked by #135, #114, #115 (all closed). ADR-0021, reliability-design Unit B.

## What already exists (do NOT rebuild)

The native path `executing → validating → verifying → review → landing → terminal`
is already wired:

- Phase machine `src/domain/run-phases.ts`: `nextPhase(phase, gate)` already forks at
  `verifying` — gate `'human'` → `review`, gate `'auto'` → `landing`.
- `Runner.runVerification` (`src/execution/runner.ts:642`) runs the command verifier
  (#135) against the frozen candidate and returns `combineVerdicts(...)`.
- The native branch in `Runner.drive` (`runner.ts` ~1005–1054):
  - `advancePhase('verifying', ...)`, run verification,
  - `decision.outcome !== 'proceed'` → `settleEscalated` (fail/inconclusive → Escalate ✓),
  - `proceed` + `autoDriven` (afk) → afk landing via `autoDrive.onCompleted` ✓,
  - `proceed` + native → **always** `advancePhase('review','human')` + `parkForReview`.
- Human Accept lands via `ReviewService.accept` → `LandingCoordinator.land` (#115).

**The single missing transition-table row** is:
`native | verifier present, auto-accept ON | pass | land (no human gate)`.

## The locked transition table (implement exactly)

| origin | verifier | verdict | outcome |
|---|---|---|---|
| native | none | — | review (park), land on Accept |
| native | present, auto-accept off | pass | review (park), land on Accept |
| native | present, auto-accept on | pass | **land, no human gate** ← NEW |
| native | present | fail (post-heal) / inconclusive | Escalate |

Auto-accept only lands when a verifier **actually ran and passed**. With NO verifier
configured, `combineVerdicts([])` returns `proceed` too — that row must still go to
review. So distinguish "proceed because a verifier passed" from "proceed, no verifier".

## Deliverables

### 1. Config surface — `src/config.ts`
Add `autoAccept` to the `verification` object (~line 257):
```ts
verification: z.object({
  command: verificationCommandSchema.nullable().default(null),
  critic: verificationCriticSchema.nullable().default(null),
  /** Auto-accept (issue #138, ADR-0021): when true, a native Run whose
   * verifier(s) PASS lands without the human review gate — the verifier's pass
   * IS the accept (ADR-0021 folds in the old `agentReview` flag). Off → a
   * passing native Run still parks for human review. No verifier configured →
   * always review, regardless of this flag (nothing verified to auto-accept). */
  autoAccept: z.boolean().default(false),
}).prefault({}),
```

### 2. Per-workspace override column — `src/db/schema.ts` + migration
Mirror `verificationCommand`/`verificationCritic`. Add to the `workspaces` table:
```ts
/** Per-Workspace auto-accept override (issue #138); null = inherit
 * `config.verification.autoAccept`. */
verificationAutoAccept: integer('verification_auto_accept', { mode: 'boolean' }),
```
Generate the migration: `npx drizzle-kit generate` (produces `drizzle/0030_*.sql` +
updates `drizzle/meta/_journal.json` idx 30 + snapshot). If drizzle-kit is unavailable,
hand-write `drizzle/0030_verification_auto_accept.sql` (`ALTER TABLE workspaces ADD
COLUMN verification_auto_accept integer;`) mirroring the 0029 style AND append the
`_journal.json` entry + snapshot. Add a `db-migration.test.ts` assertion if that file
already asserts per-column presence (check first; don't force it).

Also add `verificationAutoAccept` to the `getWorkspace` return `Pick<WorkspaceRow, ...>`
in `RunnerOptions` (`runner.ts:82`).

### 3. Resolver — `src/domain/setting-override.ts`
Extend `ResolvedVerifiers` and `resolveVerifiers`:
```ts
export interface ResolvedVerifiers {
  command: VerificationCommand | null;
  critic: VerificationCritic | null;
  autoAccept: boolean;
}
// in resolveVerifiers, ws param Pick gains 'verificationAutoAccept':
autoAccept: ws.verificationAutoAccept ?? config.verification.autoAccept,
```
Update the `ws` param type to `Pick<WorkspaceRow, 'verificationCommand' |
'verificationCritic' | 'verificationAutoAccept'>`. Check `tests/setting-override.ts` /
`tests/workspace-overrides.test.ts` and any other caller — add `verificationAutoAccept`
to the fallback literals they pass.

### 4. Runner — `src/execution/runner.ts`

(a) `runVerification` returns richer result. Change return type to:
```ts
Promise<{ decision: VerificationDecision; ran: boolean; autoAccept: boolean }>
```
- `ran` = `verdicts.length > 0` (a verifier produced a verdict).
- `autoAccept` = the resolved `autoAccept` from the SAME `resolveVerifiers` call it
  already makes (destructure it: `const { command, autoAccept } = resolveVerifiers(...)`).
- Return `{ decision: combineVerdicts(verdicts), ran: verdicts.length > 0, autoAccept }`.

(b) Add a new optional injected hook to `RunnerOptions`:
```ts
/** Lands a native auto-accept Run (issue #138): the verifier passed and the
 * resolved verifier config sets auto-accept, so Harmonic lands the result via
 * the same journaled LandingCoordinator the human Accept uses (#115), skipping
 * the review gate. Absent → auto-accept never fires (Runs park for review).
 * Returns ok:false on a landing failure (e.g. a merge conflict from a moved
 * base) — the Runner then degrades to the human gate rather than settling. */
autoAcceptLand?: (task: TaskRow, run: RunRow, patch: Partial<RunRow>) => Promise<{ ok: boolean; detail?: string }>;
```
Store it as a private field (mirror `autoDrive`/`getWorkspace`).

(c) In `drive`, update the verification call site (~1006) and the native branch
(~1044–1054):
```ts
const { decision, ran, autoAccept } = await this.runVerification(task, run, active.verifyAbort.signal, record);
// ... keep the shuttingDown / externallySettled re-checks unchanged ...
if (decision.outcome !== 'proceed') {
  // fail/inconclusive → Escalate (auto-accept NEVER rescues a red verdict — this
  // branch is checked before auto-accept). Unchanged from #135.
  ...settleEscalated...
} else if (autoDriven) {
  ...unchanged afk landing...
} else if (ran && autoAccept && this.autoAcceptLand) {
  // Native auto-accept (issue #138, transition-table row 3): a verifier ran and
  // PASSED and the resolved config sets auto-accept, so land WITHOUT a human
  // gate. `executing → validating → verifying → landing` ('auto' gate).
  advancePhase('landing', 'auto');
  const landed = await this.autoAcceptLand(task, run, patch);
  if (!landed.ok) {
    // CRITICAL: the LandingCoordinator wrote the land fact + PONC BEFORE the
    // (failed) merge (#115). Calling any settle here would project that frozen
    // land fact and SILENTLY COMPLETE a failed merge (run-settle.ts:107 writes
    // the terminal row while the Run is still `running`) — the exact "broken
    // work lands" failure this epic exists to prevent. So do NOT settle. Degrade
    // to the human gate: park in review with the failure as feedback; a human
    // resolves the conflict and re-accepts (landing reconciles the half-applied
    // effect) or the review-SLA sweep collects it. No silent pass, no lease wedged.
    record('lifecycle', { event: 'auto-accept-landing-failed', reason: landed.detail ?? 'landing failed' });
    this.parkForReview(task, run, {
      ...patch,
      reviewFeedback: `auto-accept landing failed: ${landed.detail ?? 'merge conflict'}`,
      stat: await this.diffstatFor(task, run.id),
    });
  }
  // landed.ok: LandingCoordinator.land already settled the Run completed +
  // phase terminal and moved the Task to completed. Nothing more to do.
} else {
  // Native, human-gated (no verifier, or auto-accept off): park for review.
  advancePhase('review', 'human');
  this.parkForReview(task, run, { ...patch, stat: await this.diffstatFor(task, run.id) });
}
```
Keep the existing doc comment; extend it to describe the auto-accept branch.

### 5. Wiring — `src/server/app.ts`
The landing-effects builder is currently an inline arg to `new ReviewService(...)`
(~lines 280–296). Extract it to a named const ABOVE both constructions:
```ts
const landingEffectsFor = (task: TaskRow, run: RunRow): LandingEffectExec[] => { ...existing body... };
```
Pass it to `ReviewService` where the inline function was. Then add `autoAcceptLand` to
the `new Runner(...)` options:
```ts
autoAcceptLand: async (task, run, patch) =>
  landing.land(
    task,
    run,
    { runState: 'completed', taskAction: 'completed', reason: null },
    landingEffectsFor(task, run),
    patch, // usage/stopReason ride the land; NO review:'accepted' — no human reviewed it
  ),
```
`landing` (the `LandingCoordinator`) and `landingEffectsFor` are both in scope. NOTE
ordering: the Runner is constructed BEFORE `landing`/`ReviewService` today (Runner at
~241, landing at ~203 actually precedes it — verify; `landing` exists at line 203 so it
IS available at the Runner construction at 241). `landingEffectsFor` only needs `Git`,
already imported. Define `landingEffectsFor` before line 241.

## Tests (TDD) — extend `tests/verification-command.test.ts` (or a sibling `tests/verification-native-review.test.ts` reusing its helpers)

Mirror the existing e2e harness (stub harness + real git Workspace). Add:

1. **auto-accept OFF + pass → review** (regression / row 2): verifier exit 0, autoAccept
   unset → Task reaches `awaiting-review`, run.phase `review`. (Already the #135 AC1 case
   — keep it green.)
2. **auto-accept ON + pass → land, no gate** (row 3, NEW): set
   `workspaces.update(id, { verificationCommand: exitCommand(0), verificationAutoAccept: true })`.
   In **direct** clean mode: Task reaches `completed` (never `awaiting-review`),
   run.state `completed`, run.phase `terminal`, run.finishedAt set, one attempt verdict
   `pass`. Assert it NEVER passed through `awaiting-review` (poll for completed; also
   assert task.state !== 'awaiting-review').
3. **auto-accept ON + fail → Escalate** (safety): `exitCommand(1)` + `verificationAutoAccept:true`
   → run.state `failed`, task.escalated true, NOT completed, NOT awaiting-review. Proves
   auto-accept never rescues a red verdict.
4. **auto-accept ON but NO verifier → review** (row 1): `verificationCommand: null` +
   `verificationAutoAccept: true` → Task parks `awaiting-review` (nothing verified to
   auto-accept). Use a fresh/clean workspace so a candidate can still be frozen but no
   verifier runs.
5. (Optional, stronger) **worktree auto-accept lands the merge**: a worktree-isolation
   task (see `tests/candidate.test.ts:274`/`reattempt.test.ts:21` for setup) with
   autoAccept on + pass → the run's branch is merged into base (assert the base branch
   HEAD now contains the run's commit) and Task completed. Only add if the worktree setup
   is straightforward with the existing helpers; the direct-mode test (#2) already proves
   the routing.

Keep `tests/review.test.ts` and all `tests/verification-*.test.ts` green.

## Verify
- `npm run typecheck` green.
- The new/changed test file green (run it alone first).
- Full `npm run test` green at the end.
- If `src/config.ts` change regenerates OpenAPI (ADR-0005), run whatever `npm run`
  script regenerates it and commit the regenerated artifact; keep web changes to only
  what typecheck demands (this is a server-side gate; no new UI required for the AC).

## Constraints
- House doc-comment style: explain the *why* (match `run-phases.ts`/`run-settle.ts` tone).
- Do NOT introduce a `verify-fail` fact type or self-heal — out of scope (#138 is Escalate
  on non-proceed, already done by #135).
- Do NOT touch `.github/workflows/*`.
- Append-only journals unchanged. No new ADR (ADR-0021 already governs this).
