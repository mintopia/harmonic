/**
 * Journaled non-interruptible merging — the PONC and reconciliation logic
 * (issue #115, reliability-design §0.3, Unit D).
 *
 * "Merging" is the set of irreversible side effects a Run's completion
 * triggers once a human (or an auto-accept gate) has said yes: merging a
 * worktree branch into its base, opening a PR, closing a tracker ticket. Once
 * the first of these starts, a racing cancel/guardrail-trip signal must NOT
 * be allowed to flip the Run's outcome to "cancelled" out from under an
 * effect that already fired (or is mid-flight) — that would either leave a
 * merged branch with a Run the operator believes never merged, or worse,
 * invite a "cancel, then retry" flow that reapplies an already-applied
 * effect (a duplicate merge/PR/ticket-close).
 *
 * The **PONC** ("Point Of No Cancel") is how the spine draws that line
 * without a lock: it is a `run_facts` seq recorded in the merging journal
 * before the first irreversible effect runs. `RunSettleCoordinator.settle`
 * (run-settle.ts) clamps its disposition cutoff to the PONC once one exists,
 * so any fact appended after it — a cancel that raced in mid-merging — is
 * audit-only: it stays in the log for the record, but cannot become the
 * winning disposition. This module is that decision (`poncCutoff`) plus the
 * journal fold/reconcile logic that makes a merging **resumable** after a
 * crash: no database, no clock, no I/O — the same seam as
 * `run-disposition.ts` — so the precedence and reconciliation contracts are
 * exhaustively unit-testable in isolation from the store and the coordinator
 * that drive them.
 */

/**
 * The merging side effects the journal understands. Only `target-ref` (a
 * worktree merge) has a live executor today (issue #115 wires the accept
 * path); `open-pr` and `ticket-close` are modelled here so later units slot
 * in without touching this module's contract — same "open for extension"
 * shape as `RUN_FACT_TYPES` (db/schema.ts).
 */
export const MERGE_EFFECTS = ['target-ref', 'open-pr', 'ticket-close'] as const;
export type MergeEffect = (typeof MERGE_EFFECTS)[number];

/** The journal row kinds, in the order a merging writes them: a `ponc` marker
 * (once, before the first effect), then an `intent`/`result` pair per effect
 * attempted, and `abandoned` when an effect failed — nothing irreversible
 * happened, so the PONC no longer freezes the disposition (ADR-0041 escalates
 * the failed merging instead of parking it for review). */
export const MERGE_JOURNAL_KINDS = ['ponc', 'intent', 'result', 'abandoned'] as const;
export type MergeJournalKind = (typeof MERGE_JOURNAL_KINDS)[number];

/** What the coordinator intends to do: apply `effect`, identified for
 * idempotency/reconciliation purposes by `idempotencyKey` (e.g. for
 * `target-ref`, the base branch + the branch being merged), carrying
 * `expected` — whatever detail a later `observed` check needs to tell
 * "already done" from "not done yet" (e.g. the branch name / target OID). */
export interface MergeIntent {
  effect: MergeEffect;
  idempotencyKey: string;
  expected: Record<string, unknown>;
}

/** The outcome of attempting an intended effect. `observed` is whatever the
 * effect's own apply step captured about the resulting world state (e.g. the
 * merge commit OID); `detail` is a human-readable failure/aux message. */
export interface MergeResult {
  effect: MergeEffect;
  idempotencyKey: string;
  ok: boolean;
  // `| undefined` (not just `?`) throughout this interface because callers
  // build these objects by forwarding an effect's own optional-shaped
  // outcome (`MergeEffectOutcome`, merge-coordinator.ts) verbatim —
  // under `exactOptionalPropertyTypes`, a property typed merely `?:` refuses
  // an explicit `undefined` value, only an absent key.
  observed?: Record<string, unknown> | undefined;
  detail?: string | undefined;
}

/**
 * The minimal shape `foldJournal`/`poncCutoff`/`reconcile` need from a
 * persisted journal row: its position in the per-Run log (`seq`), its `kind`,
 * and — for `intent`/`result` rows — the effect identity it's about.
 * `payload` is the row's JSON payload **already decoded** (the store's job,
 * mirroring how `run-settle.ts` decodes a `run_fact`'s payload before handing
 * it to the pure coordinator functions) — this module never parses JSON
 * itself, keeping it free of any serialization concern.
 */
export interface MergeJournalRowView {
  seq: number;
  kind: MergeJournalKind;
  effect: MergeEffect | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
}

/** Per-idempotency-key fold of the journal: what was intended, and what the
 * result rows say happened. */
export interface JournalEntry {
  effect: MergeEffect;
  idempotencyKey: string;
  /** An `intent` row exists for this key. */
  intended: boolean;
  /** A `result` row with `ok:true` exists for this key — the effect is
   * **applied** by the definition this module uses everywhere. */
  appliedOk: boolean;
  /** A `result` row with `ok:false` exists for this key (independent of
   * `appliedOk` — a failed attempt does not erase an earlier or later ok one,
   * though in practice `merge` stops at the first failure so the two rarely
   * coexist; kept independent so this fold stays a pure, total summary of
   * whatever the log actually contains). */
  appliedFailed: boolean;
}

/**
 * Fold a Run's merging journal into one entry per idempotency key —
 * `merge`/`reconcileMerge`'s shared view of "what has this merging tried,
 * and did it work". `ponc` rows carry no effect/idempotencyKey and are
 * skipped; every `intent`/`result` row is attributed to its `idempotencyKey`
 * (not `effect` alone, since a merging can intend the same effect kind
 * multiple times with different identities — not true for `target-ref` today,
 * but true in general, e.g. `ticket-close` against different tracker refs).
 *
 * Pure and total: order of `rows` doesn't matter beyond seq order already
 * being the log's true order (append-only, so callers pass rows in seq order,
 * but this fold doesn't itself depend on that — it merges by key regardless).
 */
export function foldJournal(rows: readonly MergeJournalRowView[]): JournalEntry[] {
  const byKey = new Map<string, JournalEntry>();
  for (const row of rows) {
    if (row.kind === 'ponc' || row.effect === null || row.idempotencyKey === null) continue;
    let entry = byKey.get(row.idempotencyKey);
    if (!entry) {
      entry = { effect: row.effect, idempotencyKey: row.idempotencyKey, intended: false, appliedOk: false, appliedFailed: false };
      byKey.set(row.idempotencyKey, entry);
    }
    if (row.kind === 'intent') entry.intended = true;
    if (row.kind === 'result') {
      if (row.payload.ok === true) entry.appliedOk = true;
      else entry.appliedFailed = true;
    }
  }
  return [...byKey.values()];
}

/**
 * The run_facts cutoff seq frozen by this Run's `ponc` journal row — the
 * Point Of No Cancel (see the module doc comment) — or `null` if merging
 * never got that far (no PONC written yet, e.g. a Run still parked in
 * `review`). `RunSettleCoordinator.settle` reads this to clamp its
 * disposition cutoff (run-settle.ts): a fact appended with `seq >
 * poncCutoff` can never win, no matter how high its precedence.
 *
 * A merging writes at most one `ponc` row (the coordinator writes it once,
 * synchronously, before the first effect — see merge-coordinator.ts); if
 * more than one is ever found (defensive — should not happen against an
 * append-only log written by one coordinator), the **first** one in `rows`
 * order wins, matching "the PONC is the earliest point past which nothing
 * can undo the merging" rather than a later, larger cutoff quietly widening
 * the window a cancel could still have won in.
 */
export function poncCutoff(rows: readonly MergeJournalRowView[]): number | null {
  const index = rows.findIndex((r) => r.kind === 'ponc');
  if (index < 0) return null;
  if (rows.slice(index + 1).some((r) => r.kind === 'abandoned')) return null;
  const cutoffSeq = rows[index]!.payload.cutoffSeq;
  return typeof cutoffSeq === 'number' ? cutoffSeq : null;
}

/** Whether the external world already shows an effect applied, keyed by its
 * idempotency identity — the boot-sweep/reconcile caller's job to answer
 * (e.g. "is `branch` already merged into `baseBranch` at HEAD?"). This module
 * only consumes the answer; it never inspects the world itself. */
export type ObservedState = 'present' | 'absent';

/** One reconciliation decision for an intended-but-not-confirmed effect. */
export interface ReconcileAction {
  effect: MergeEffect;
  key: string;
  action: 'already-applied' | 'adopt' | 'apply';
}

/**
 * Reconcile a Run's merging journal against the observed world
 * (issue #115). This is what makes a journaled merging survive a crash: a
 * process that dies between `recordIntent` and `recordResult` leaves an
 * effect in an ambiguous state — it may have actually applied (e.g. the merge
 * commit merged just before the process died) or may never have started. A
 * fresh coordinator can't tell from the journal alone, so it asks the world
 * (`observed`) and decides:
 *
 *   - a `result` row with `ok:true` already exists for the key -> the log
 *     already knows this succeeded: `'already-applied'`, nothing to do.
 *   - no ok result, and the world reports the effect present -> `'adopt'`:
 *     record the result as if it just succeeded, but do **NOT** re-run the
 *     effect. Re-applying here is exactly the bug this module exists to
 *     prevent — a second merge attempt on an already-merged branch is either
 *     a silent duplicate or (worse) a false conflict that parks a Run that
 *     actually merged.
 *   - no ok result, and the world reports the effect absent -> `'apply'`:
 *     genuinely never happened (or definitively failed and left no trace);
 *     safe, in fact necessary, to run it.
 *
 * An intended effect with no `intent` row at all is impossible by
 * construction (every entry in `foldJournal`'s output came from an intent or
 * result row); an effect with **no** intent row in the raw journal — i.e.
 * `merge` never got to it — is correctly absent from the result: reconcile
 * only ever resumes work that was actually started.
 *
 * Idempotent by construction: once every intended effect has an `ok:true`
 * result, every entry falls into the first branch — calling `reconcile` again
 * (e.g. a duplicate boot sweep) always yields the same all-`already-applied`
 * set, a no-op for the caller to iterate over.
 */
export function reconcile(
  rows: readonly MergeJournalRowView[],
  observed: (effect: MergeEffect, idempotencyKey: string) => ObservedState,
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const entry of foldJournal(rows)) {
    if (!entry.intended) continue; // never started — not this reconcile's job
    if (entry.appliedOk) {
      actions.push({ effect: entry.effect, key: entry.idempotencyKey, action: 'already-applied' });
      continue;
    }
    const state = observed(entry.effect, entry.idempotencyKey);
    actions.push({ effect: entry.effect, key: entry.idempotencyKey, action: state === 'present' ? 'adopt' : 'apply' });
  }
  return actions;
}
