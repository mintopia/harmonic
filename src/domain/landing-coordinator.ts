import type { RunRow, TaskRow, RunFactType } from '../db/schema.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { RunStore } from './runs.js';
import { appendRunFactTx } from './run-facts.js';
import { appendLandingJournalTx, type LandingJournalStore } from './landing-journal.js';
import type { RunSettleCoordinator } from './run-settle.js';
import type { SettleProjection } from './run-coordinator.js';
import { reconcile, type LandingEffect, type ObservedState, type ReconcileAction } from './landing.js';
import type { SpanContext } from '@opentelemetry/api';
import { startOperation } from '../telemetry/operations.js';

/**
 * The journaled, non-interruptible landing operation (issue #115,
 * reliability-design §0.3, Unit D).
 *
 * `RunSettleCoordinator.settle` (run-settle.ts) is *a* precedence decision —
 * it doesn't know or care what side effects a disposition implies. Landing is
 * different: "land" means actually doing irreversible things (merge a
 * branch, open a PR, close a ticket) before the Run can honestly be called
 * settled. Those effects can't be wrapped in a database transaction — a git
 * merge or a tracker API call has no rollback this process controls — so this
 * module makes landing *resumable* instead of atomic: every step is journaled
 * (landing-journal.ts) before/after it happens, and a PONC (Point Of No
 * Cancel — see landing.ts's module doc comment) freezes the Run's disposition
 * the instant the first effect is about to run, so a racing cancel can never
 * again flip the outcome away from a land already underway.
 *
 * This class owns exactly two operations:
 *   - {@link land} — drive a fresh landing from its first effect to terminal.
 *   - {@link reconcileLanding} — resume a landing whose process died
 *     mid-flight, by asking the world what actually happened
 *     (`reconcile`, landing.ts) rather than trusting the journal alone.
 *
 * Today only the worktree merge (`target-ref`) has a live executor (wired in
 * src/server/app.ts's `EscalationService`); `open-pr`/`ticket-close` are
 * modelled (`LandingEffect`) but unused until later units add their
 * executors — this coordinator's contract doesn't change when they do.
 */
export class LandingCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly db: AsyncDbHandle,
    private readonly journal: LandingJournalStore,
    private readonly settle: RunSettleCoordinator,
    private readonly opts: {
      timeoutMs?: number;
      now?: () => number;
      parentForRun?: (runId: number) => SpanContext | undefined;
      onTerminalRun?: (runId: number) => Promise<void>;
    } = {},
  ) {}

  /**
   * Land `run`: freeze the PONC, then attempt each effect in order, then
   * settle terminal. `landProjection` is the terminal projection this landing
   * intends (matching `RunSettleCoordinator.settle`'s contract) — carried
   * through to the land `run_fact` and (on success) to the actual settle
   * call. `patch` rides the winning settle write exactly as it does for
   * `RunSettleCoordinator.settle` directly. `landFactType` is the disposition
   * kind the land fact appends as; it defaults to {@link LAND_FACT_TYPE}
   * (`agent-finish/unresolved`). `EscalationService.accept` passes
   * `'operator-accept'` instead: an explicit operator Accept must outrank the
   * `escalate` fact already sitting on the Run's log
   * (`DISPOSITION_PRECEDENCE`, run-disposition.ts), which a bare
   * `agent-finish/unresolved` cannot.
   *
   * Ordering (the PONC mechanism):
   *
   *   1. Ensure `run.phase === 'landing'` (recorded + a lifecycle event).
   *   2. Append the land disposition fact **directly** (NOT through `settle`
   *      yet, because `settle` would also write the Run row/release the
   *      lease/apply the Task action, and effects haven't run — the operator
   *      must not see "landed" before the merge (etc.) has actually happened)
   *      AND freeze the PONC at that fact's seq, both inside ONE
   *      `AsyncDbHandle.transaction`. On the async Db the two writes must be a
   *      single write-queue unit (ADR-0029): the transaction is exclusive, so a
   *      concurrent settle's own `run_facts` append is ordered strictly before
   *      or after this whole unit — it can never slip in between the land fact
   *      and its PONC row and observe a not-yet-frozen cutoff.
   *   3. With the PONC frozen at the land fact's seq, that fact is now
   *      guaranteed decisive: any fact any concurrent settle call appends for
   *      this Run — a cancel, a guardrail trip, anything — lands at a strictly
   *      greater seq (monotonic `max+1`), so `RunSettleCoordinator.settle`'s
   *      PONC clamp (run-settle.ts) excludes it from ever winning: it stays in
   *      the log as an audit record, but the land frozen in at step 2 is what
   *      the operator sees.
   *   4. For each effect, in order: record intent, run `apply()` (bounded by
   *      the operation timeout — see {@link LANDING_OP_TIMEOUT_MS}), record
   *      the result. The first `ok:false` stops the loop and returns
   *      `{ ok:false, detail }` **without** calling `settle`, and re-parks the
   *      Run at review so the Task stays actionable without consuming capacity.
   *      Everything already-applied before the failing effect stays applied
   *      and journaled; nothing here retries or rolls anything back — that is
   *      `reconcileLanding`'s job, driven by a later, deliberate call.
   *   5. All effects `ok:true`: call `settle.settle` to do the actual Run
   *      row write / lease release / Task action. This appends a *second*
   *      land fact (settle always appends), landing after the PONC — audit-
   *      only, harmless, since the winning disposition was already decided
   *      by the step-2 fact. If a race already resolved the Run through the
   *      PONC clamp (a concurrent cancel's `settle` call, forced to see this
   *      land as decisive — see run-settle.ts), this call idempotently
   *      no-ops (the existing "already not running" guard in `settle`).
   */
  async land(
    task: TaskRow,
    run: RunRow,
    landProjection: SettleProjection,
    effects: readonly LandingEffectExec[],
    patch: Partial<RunRow> = {},
    landFactType: RunFactType = LAND_FACT_TYPE,
    parent = this.opts.parentForRun?.(run.id),
  ): Promise<LandingOutcome> {
    // Parented from the live Run when there is one; an operator Accept on an
    // escalated ticket (Run already settled) lands as its own root operation.
    const operation = startOperation({ type: 'land', parent, attributes: { 'task.id': task.id, 'run.id': run.id, 'landing.mechanism': 'coordinator' } });
    try {
      const outcome = await operation.run(() => this.landUnchecked(task, run, landProjection, effects, patch, landFactType));
      if (outcome.ok) {
        operation.end();
        await this.opts.onTerminalRun?.(run.id);
      } else {
        operation.fail(outcome.detail ?? 'landing failed');
      }
      return outcome;
    } catch (error) {
      operation.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async landUnchecked(
    task: TaskRow,
    run: RunRow,
    landProjection: SettleProjection,
    effects: readonly LandingEffectExec[],
    patch: Partial<RunRow>,
    landFactType: RunFactType,
  ): Promise<LandingOutcome> {
    const now = this.opts.now ?? Date.now;

    // Steps 2 + 3 (the PONC freeze) run FIRST, before any other work: append the
    // land fact and freeze the PONC at its seq — as ONE transaction (ADR-0029).
    // Both `run_facts` and `landing_journal` are now on the async Db, so the two
    // writes MUST be a single write-queue unit: the transaction is one exclusive
    // unit, so a racing settle's own `run_facts` append (a separate `.write()`)
    // is strictly ordered relative to it — never interleaved between the land
    // fact and its PONC row. A settle whose cancel fact lands at a higher seq
    // than this land fact enqueued its append behind this whole transaction, so
    // by the time it appends and reads the PONC (`RunSettleCoordinator.settle`
    // reads it *after* its own append) the freeze has already committed and the
    // cancel is clamped to audit-only. Splitting this back into an awaited append
    // then a separate `writePonc` would let that racing append slip in between
    // and read a `null` PONC — the exact bug this atomicity prevents. The
    // phase-transition writes below run only after the freeze, so a concurrent
    // settle during those awaits already sees the PONC frozen.
    await this.db.transaction(async (tx) => {
      const landFact = await appendRunFactTx(tx, run.id, landFactType, { ...landProjection }, now());
      await appendLandingJournalTx(tx, run.id, 'ponc', { payload: { cutoffSeq: landFact.seq } }, now());
    });

    // Now that RunStore is async these are awaited, so a concurrent settle during
    // this await already sees the PONC frozen above and is clamped to audit-only.
    if (run.phase !== 'landing') {
      await this.runStore.update(run.id, { phase: 'landing' });
      await this.runStore.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'phase', phase: 'landing' } });
    }

    const timeoutMs = this.opts.timeoutMs ?? LANDING_OP_TIMEOUT_MS;
    for (const effect of effects) {
      await this.journal.recordIntent(
        run.id,
        { effect: effect.effect, idempotencyKey: effect.idempotencyKey, expected: effect.expected },
        now(),
      );
      const result = await withTimeout(effect.apply, timeoutMs, effect.effect);
      await this.journal.recordResult(
        run.id,
        { effect: effect.effect, idempotencyKey: effect.idempotencyKey, ok: result.ok, observed: result.observed, detail: result.detail },
        now(),
      );
      if (!result.ok) {
        await this.abandon(run, result.detail ?? 'landing failed');
        return { ok: false, detail: result.detail };
      }
    }

    await this.settle.settle(task, run, landFactType, landProjection, patch);
    return { ok: true };
  }

  /**
   * Record that this landing did not happen: lifts the PONC (`poncCutoff`
   * ignores a frozen cutoff followed by `abandoned`) so the caller's escalate
   * fact can decide the Run instead of the land fact silently completing a
   * failed merge. Nothing irreversible ran — effects are fail-fast and the
   * failed one is the first non-ok result.
   */
  async abandon(run: RunRow, detail: string): Promise<void> {
    await this.journal.append(run.id, 'abandoned', { payload: { detail } }, (this.opts.now ?? Date.now)());
    // The Run never landed, so it leaves `landing` for wherever it was — an
    // already-settled (escalated) Run goes back to `terminal`.
    if (run.phase !== 'landing') await this.runStore.update(run.id, { phase: run.phase });
    await this.runStore.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'landing-abandoned', detail } });
  }

  /**
   * Resume a Run's landing journal against the observed world (issue #115):
   * runs {@link reconcile} (landing.ts) over the journal, and for every
   * `'adopt'` action records the confirming result (never re-applies — that
   * is precisely the duplicate-merge/PR/close bug PONC + reconcile exist to
   * prevent). For every `'apply'` action, re-runs the effect via the matching
   * entry in `executors` (keyed by `LandingEffect`) if one was supplied —
   * this is how the eventual boot-sweep wiring (a separate ticket; out of
   * scope here) drives real recovery, while a substrate test can call this
   * directly with inline executors and no boot machinery at all. An `'apply'`
   * action with no matching executor is left as-is (still `intended`, still
   * un-resulted) for a later reconcile pass to pick up.
   *
   * Deliberately does **not** call `settle` — completing a Run whose landing
   * process died mid-flight is the crash-recovery boot sweep's decision to
   * make (it owns *when* to run reconciliation at all), not this substrate's.
   * Idempotent: reconciling an already-fully-applied landing yields every
   * action `'already-applied'` and this loop does nothing.
   */
  async reconcileLanding(
    run: RunRow,
    observed: (effect: LandingEffect, idempotencyKey: string) => ObservedState,
    executors: Partial<Record<LandingEffect, LandingEffectExecutor>> = {},
  ): Promise<ReconcileAction[]> {
    const rows = await this.journal.views(run.id);
    const actions = reconcile(rows, observed);
    for (const action of actions) {
      if (action.action === 'already-applied') continue;
      if (action.action === 'adopt') {
        // The world already shows this effect done — record it as such
        // WITHOUT running `apply` again (the whole point: no duplicate
        // merge/PR/close, no false conflict against work that already landed).
        await this.journal.recordResult(run.id, { effect: action.effect, idempotencyKey: action.key, ok: true, observed: { adopted: true } });
        continue;
      }
      // action === 'apply': genuinely never happened (or definitively failed
      // and left no trace) — safe, and necessary, to run it for real.
      const executor = executors[action.effect];
      if (!executor) continue; // no executor supplied — leave pending
      const intentRow = rows.find((r) => r.kind === 'intent' && r.idempotencyKey === action.key);
      const expected = (intentRow?.payload['expected'] as Record<string, unknown> | undefined) ?? {};
      const result = await executor(action.key, expected);
      await this.journal.recordResult(run.id, { effect: action.effect, idempotencyKey: action.key, ok: result.ok, observed: result.observed, detail: result.detail });
    }
    return actions;
  }
}

/**
 * The default disposition type a journaled landing settles under when the
 * caller doesn't name one (issue #191; was the sole, hardcoded kind pre-#191
 * — a successful landing was always `agent-finish/unresolved` with a
 * `completed`-projecting payload, matching `ReviewService.accept`'s pre-#115
 * direct call). Now a parameter (`land`'s `landFactType`) so an operator's
 * explicit Accept can settle under `'operator-accept'` instead — this
 * constant is only the default every existing caller keeps getting.
 */
const LAND_FACT_TYPE: RunFactType = 'agent-finish/unresolved';

/**
 * The operation timeout for a single landing effect's `apply()` (issue #115).
 * Deliberately independent of any execution-harness timeout — landing runs
 * AFTER the harness process is done, so it has its own budget. Five minutes
 * comfortably covers a worktree merge; effects with heavier network calls
 * (opening a PR, closing a ticket) can override via `LandingCoordinator`'s
 * `timeoutMs` option.
 */
export const LANDING_OP_TIMEOUT_MS = 5 * 60_000;

/** An effect result callback shape shared by {@link LandingEffectExec.apply}
 * and the reconciliation `executors` map. `| undefined` on the optional
 * fields (not just `?:`) so this forwards cleanly into `LandingResult`
 * (landing.ts) under `exactOptionalPropertyTypes` — see that type's doc
 * comment. */
export type LandingEffectOutcome = { ok: boolean; observed?: Record<string, unknown> | undefined; detail?: string | undefined };

/** One landing side effect this operation must apply, in order. `apply` is
 * expected to resolve (not throw) with its outcome — see `withTimeout`'s doc
 * comment for what happens if it doesn't resolve within the operation budget. */
export interface LandingEffectExec {
  effect: LandingEffect;
  idempotencyKey: string;
  expected: Record<string, unknown>;
  apply: () => Promise<LandingEffectOutcome>;
}

/** A reconciliation-time re-apply of one effect, keyed by `LandingEffect` in
 * the `executors` map `reconcileLanding` takes — same outcome shape as
 * `LandingEffectExec.apply`, but driven by the journal's recorded identity/
 * expected detail rather than a fresh `LandingEffectExec`. */
export type LandingEffectExecutor = (
  idempotencyKey: string,
  expected: Record<string, unknown>,
) => Promise<LandingEffectOutcome>;

/** What `land` returns: `ok:true` once every effect applied and the Run
 * settled terminal; `ok:false` (with the failing effect's `detail`) the
 * instant one doesn't — the caller (e.g. `ReviewService.accept`) is
 * responsible for surfacing that to the operator exactly as it does today. */
export interface LandingOutcome {
  ok: boolean;
  detail?: string | undefined;
}

/**
 * Race `apply()` against a timer so one stuck effect (a git process that
 * never returns, a hung HTTP call) can't wedge `land` forever. This does
 * **not** cancel the underlying operation — there is no cancellation token
 * threaded through `apply`, and forcibly killing a git merge mid-flight would
 * be its own correctness hazard. If `apply()` eventually does resolve after
 * the timeout already fired, its result is simply never observed by this
 * call; but the operation may well have actually completed in the
 * background. That is precisely the case {@link LandingCoordinator.reconcileLanding}
 * exists to clean up: a later reconcile asks the world (`observed`) and
 * `'adopt's` the effect if it turns out to have landed anyway, rather than
 * re-applying it.
 */
function withTimeout(
  apply: () => Promise<LandingEffectOutcome>,
  timeoutMs: number,
  effect: LandingEffect,
): Promise<LandingEffectOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, detail: `landing effect '${effect}' timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    apply().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}
