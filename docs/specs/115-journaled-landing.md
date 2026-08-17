# Issue #115 — Journaled non-interruptible landing (PONC + reconcile)

Reliability coordination spine, child of #106; blocked by #114 (done). Reliability-design §0.3, §Unit D.

This ticket owns **the journal, the PONC, and the reconciliation logic itself**. The
boot-sweep wiring that *invokes* reconciliation at startup is out of scope (owned by the
crash-recovery ticket). Landing side effects that don't exist yet (open-PR, ticket-close)
are modelled by the effect enum + reconcile logic but only the **worktree merge** effect is
wired live today (the accept hook in `src/server/app.ts` / `ReviewService.accept`).

## Existing spine (context)

- `run_facts` append-only log; `RunFactStore.append/list` (src/domain/run-facts.ts).
- `computeDisposition(facts, cutoff)` — pure precedence collapse; facts with `seq > cutoff`
  are audit-only (src/domain/run-disposition.ts). **This cutoff IS the PONC mechanism.**
- `projectSettle(facts, cutoff)` — winning fact's projection (src/domain/run-coordinator.ts).
- `RunSettleCoordinator.settle(task, run, type, projection, patch)` — the single settle
  authority (src/domain/run-settle.ts). Appends the fact, recomputes the winner, writes the
  Run row + releases lease + applies Task action only when the decision changes.
- Phase machine: `RUN_PHASES = [...'review','landing','terminal']`; `landing` phase exists
  (src/domain/run-phases.ts).
- `ReviewService.accept` (src/domain/review.ts): runs `acceptHook` (the merge) then
  `settle('agent-finish/unresolved', {completed})`. The accept hook in app.ts:239-245 does
  `Git.merge(workingDir, baseBranch, branch)` for worktree Runs.
- Drizzle migrations in `./drizzle`, applied by `openDb` via `migrate()`. Latest = 0026.

## Deliverables

### 1. Migration + schema — `landing_journal`

New drizzle migration `drizzle/0027_landing_journal.sql` (+ `drizzle/meta` update via
`npx drizzle-kit generate`) and `src/db/schema.ts` table:

```
landing_journal:
  id            integer PK autoincrement
  run_id        integer NOT NULL -> runs(id)
  seq           integer NOT NULL           -- per-run monotonic, 1-based
  ts            integer NOT NULL
  kind          text NOT NULL              -- 'ponc' | 'intent' | 'result'
  effect        text                       -- 'target-ref'|'open-pr'|'ticket-close'; NULL for 'ponc'
  idempotency_key text                     -- effect identity; NULL for 'ponc'
  payload       text NOT NULL default '{}' -- JSON
  unique index landing_journal_run_seq_unique on (run_id, seq)
```

Append-only, same discipline as `run_facts`. `LANDING_EFFECTS`, `LandingEffect`,
`LandingJournalRow` exported like the run_facts equivalents. Prefer `drizzle-kit generate`
to author the SQL so the snapshot/journal stay consistent; if the tool is unavailable,
hand-write the `.sql` mirroring 0026 style AND append the `drizzle/meta/_journal.json`
entry (idx 27) + snapshot.

### 2. Pure logic — `src/domain/landing.ts`

No DB/clock/IO — same seam as run-disposition.ts. Exhaustively unit-tested.

- `LANDING_EFFECTS = ['target-ref','open-pr','ticket-close'] as const;` + `LandingEffect`.
- Shapes: `LandingIntent { effect; idempotencyKey; expected: Record<string,unknown> }`,
  `LandingResult { effect; idempotencyKey; ok: boolean; observed?: Record<string,unknown>; detail?: string }`.
- A minimal journal-row view interface `{ seq; kind; effect?; idempotencyKey?; payload }`.
- `foldJournal(rows)` -> per idempotency key: `{ effect, idempotencyKey, intended: bool,
  appliedOk: bool, appliedFailed: bool }`. An effect is **applied** iff a `result` row with
  `ok:true` exists for its key.
- `poncCutoff(rows): number | null` — the run_facts cutoff seq recorded by the `ponc` row
  (payload `{ cutoffSeq }`), or null if no PONC written.
- `reconcile(rows, observed): ReconcileAction[]` where `observed(effect, idempotencyKey) ->
  'present' | 'absent'` reports whether the external world already shows the effect (by its
  idempotency identity). Per intended-but-not-confirmed effect:
    - result row ok:true already present            -> `{ effect, key, action: 'already-applied' }`
    - no result, observed 'present'                 -> `{ effect, key, action: 'adopt' }`   (record result, DO NOT re-apply — prevents duplicate merge/PR/close and false conflict)
    - no result, observed 'absent'                  -> `{ effect, key, action: 'apply' }`
  Effects with no intent row -> not returned. **Idempotent**: running `reconcile` again after
  every effect has an ok result yields all `already-applied` (a no-op set).

### 3. Store — `src/domain/landing-journal.ts`

`LandingJournalStore` (mirror RunFactStore):
- `append(runId, kind, { effect?, idempotencyKey?, payload }, now?) -> LandingJournalRow`
  assigning `seq = max(seq)+1` per run.
- `list(runId) -> LandingJournalRow[]` in seq order.
- Convenience: `writePonc(runId, cutoffSeq, now?)`, `recordIntent(runId, intent, now?)`,
  `recordResult(runId, result, now?)`, `ponc(runId) -> number | null` (uses `poncCutoff`).

### 4. Landing operation — `src/domain/landing-coordinator.ts`

`LandingCoordinator` — the journaled, non-interruptible landing operation. Owns its own
operation timeout, independent of the execution clock (accept a `timeoutMs` option +
injected `now`/clock; default from a `LANDING_OP_TIMEOUT_MS` const). Constructor deps:
`RunStore`, `RunFactStore`, `LandingJournalStore`, `RunSettleCoordinator`.

`async land(task, run, landProjection, effects: LandingEffectExec[]): Promise<LandingOutcome>`
where `LandingEffectExec = { effect; idempotencyKey; expected; apply: () => Promise<{ ok; observed?; detail? }> }`:

1. Ensure Run is in `phase:'landing'` (write it + lifecycle event if not already).
2. **Write the land terminal fact first** so the pre-PONC winner is the land: append the
   land disposition fact via the settle path is deferred; instead record it as a pending
   projection. Simplest correct ordering: append the land `run_fact` (the projection) to the
   log via `RunFactStore` is what `settle` does — so capture `cutoffSeq = current max
   run_facts seq` AFTER the last pre-landing fact, write the PONC (`writePonc(runId,
   cutoffSeq)`) **before the first irreversible effect**.  Document precisely in code which
   seq is frozen and why a post-PONC cancel is excluded.
3. For each effect in order: `recordIntent` -> `apply()` (bounded by the operation timeout)
   -> `recordResult`. On the first `ok:false`, stop and return `{ ok:false, detail }`
   WITHOUT settling terminal (caller leaves Task awaiting-review — matches today's merge
   conflict path).
4. On all-ok: `settle.settle(task, run, landType, landProjection, patch)` to land terminal.
5. `reconcileLanding(task, run, observed)` entry point: run `reconcile` over the journal and
   for each `adopt` record the result; for each `apply` re-run the effect's apply if an
   executor is supplied (boot wiring supplies executors; substrate test drives it directly).
   Idempotent: a completed landing reconciles to all `already-applied` and changes nothing.

### 5. PONC freeze in `RunSettleCoordinator`

Inject an **optional** `LandingJournalStore` (back-compat: existing call sites without it
behave exactly as today). In `settle`, if a PONC exists for the run, clamp the disposition
cutoff to `min(latestSeq, poncCutoffSeq)` for BOTH `priorDisposition` and the post-append
`disposition`. Effect: a cancel/guardrail fact appended after the PONC has `seq >
poncCutoffSeq`, is excluded from the decision (audit-only in the log), and the land stands —
`operator sees "landed", not "cancelled"`. Keep the fact appended (audit). Add a focused
comment referencing §0.3 and #115.

### 6. Wire the live accept path

Route the worktree merge through `LandingCoordinator` so the one live landing side effect is
journaled + PONC-guarded. In `src/server/app.ts`, construct a `LandingJournalStore` and a
`LandingCoordinator`, pass the journal store into the review `RunSettleCoordinator`
(PONC-aware), and refactor `ReviewService` to land via the coordinator (the merge becomes the
`target-ref` effect with idempotency identity = base branch + merged commit OID / branch).
Keep merge-conflict behavior identical (task stays awaiting-review, `reviewFeedback` set).
Preserve the existing default-no-op acceptHook behavior for non-worktree Runs (no effects ->
straight land). Do not break existing review tests.

## Tests (TDD, vitest; mirror tests/ structure)

- `tests/landing.test.ts` — pure: foldJournal, poncCutoff, reconcile (all 4 action classes +
  idempotency: reconcile-after-complete is a no-op set).
- `tests/landing-journal.test.ts` — store append monotonic seq, list order, ponc round-trip,
  raw `(run_id, seq)` unique rejects duplicate (mirror the run_facts migration test).
- `tests/landing-coordinator.test.ts` — **the AC harness**:
    - each effect writes intent -> apply -> result keyed by idempotency identity;
    - a cancel fact appended after PONC is audit-only: settle leaves Run "landed"
      (state completed / phase terminal), the cancel row exists in run_facts but did not win;
    - **simulated mid-landing crash**: intent written, no result, process "dies"; a fresh
      coordinator `reconcileLanding` with `observed='present'` for the half-applied effect
      -> `adopt` (records result, does NOT re-apply) so NO duplicate merge/PR/close and NO
      false conflict; with `observed='absent'` -> `apply` once;
    - reconcile after a completed landing is a no-op (all already-applied).
- `tests/db-migration.test.ts` — add a `landing_journal` block mirroring the run_facts one
  (exists at head; `(run_id, seq)` unique rejects duplicate seq).
- Extend/keep `tests/review*.test.ts` green (accept still lands, conflict still parks).

## Verify

`npm run typecheck` and the full `npm run test` green. Run single new test files during dev.

## Constraints

- Follow the house style: heavy doc-comments explaining the *why* (match run-disposition.ts /
  run-phases.ts tone). Pure modules stay pure (no DB import in landing.ts).
- Append-only journal; no update/delete path (results are new rows).
- Do not touch `.github/workflows/*` (unrelated deletions in the working tree).
