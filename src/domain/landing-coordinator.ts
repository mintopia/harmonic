import type { RunRow, TaskRow, RunFactType } from '../db/schema.js';
import type { RunStore } from './runs.js';
import type { RunFactStore } from './run-facts.js';
import type { LandingJournalStore } from './landing-journal.js';
import type { RunSettleCoordinator } from './run-settle.js';
import type { SettleProjection } from './run-coordinator.js';
import { reconcile, type LandingEffect, type ObservedState, type ReconcileAction } from './landing.js';

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
 * src/server/app.ts's `ReviewService`); `open-pr`/`ticket-close` are
 * modelled (`LandingEffect`) but unused until later units add their
 * executors — this coordinator's contract doesn't change when they do.
 */
export class LandingCoordinator {
  constructor(
    private readonly runStore: RunStore,
    private readonly runFacts: RunFactStore,
    private readonly journal: LandingJournalStore,
    private readonly settle: RunSettleCoordinator,
    private readonly opts: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  /**
   * Land `run`: freeze the PONC, then attempt each effect in order, then
   * settle terminal. `landProjection` is the terminal projection this landing
   * intends (matching `RunSettleCoordinator.settle`'s contract) — carried
   * through to the land `run_fact` and (on success) to the actual settle
   * call. `patch` rides the winning settle write exactly as it does for
   * `RunSettleCoordinator.settle` directly (e.g. the review decoration
   * `{ review: 'accepted', reviewedAt, reviewDeadline: null }`). `landFactType`
   * (issue #191) is the disposition kind the land fact appends as; it defaults
   * to {@link LAND_FACT_TYPE} (`agent-finish/unresolved`) so every existing
   * caller is unchanged. `ReviewService.accept`'s native-running branch passes
   * `'operator-accept'` instead: an explicit operator Accept must outrank an
   * `escalate` fact already sitting on an adopted-for-review Run's log
   * (`DISPOSITION_PRECEDENCE`, run-disposition.ts), which a bare
   * `agent-finish/unresolved` cannot.
   *
   * Ordering (the PONC mechanism):
   *
   *   1. Ensure `run.phase === 'landing'` (recorded + a lifecycle event, same
   *      as `ReviewService.accept`'s pre-#115 inline version of this step).
   *   2. Append the land disposition fact **directly** via `RunFactStore` —
   *      NOT through `settle` yet, because `settle` would also write the Run
   *      row/release the lease/apply the Task action, and effects haven't
   *      run — the operator must not see "landed" before the merge (etc.)
   *      has actually happened. This append is what "reserves" the seq the
   *      land fact needs: because it happens synchronously, before this
   *      method's first `await`, nothing else can interleave and steal that
   *      seq out from under it.
   *   3. Immediately write the PONC, freezing `run_facts`'s disposition
   *      cutoff at exactly that seq — the fact appended in step 2 is now
   *      guaranteed decisive. From this point, any fact any concurrent
   *      settle call appends for this Run — a cancel, a guardrail trip,
   *      anything — lands at a strictly greater seq (monotonic `max+1`), so
   *      `RunSettleCoordinator.settle`'s PONC clamp (run-settle.ts) excludes
   *      it from ever winning: it stays in the log as an audit record, but
   *      the land already frozen in at step 2 is what the operator sees.
   *   4. For each effect, in order: record intent, run `apply()` (bounded by
   *      the operation timeout — see {@link LANDING_OP_TIMEOUT_MS}), record
   *      the result. The first `ok:false` stops the loop and returns
   *      `{ ok:false, detail }` **without** calling `settle` — the Task stays
   *      in `awaiting-review` (today's merge-conflict behaviour, unchanged).
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
  ): Promise<LandingOutcome> {
    const now = this.opts.now ?? Date.now;

    if (run.phase !== 'landing') {
      this.runStore.update(run.id, { phase: 'landing' });
      this.runStore.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'phase', phase: 'landing' } });
    }

    // Step 2 + 3: freeze the PONC before the first irreversible effect. See
    // the doc comment above for exactly why this ordering is race-safe.
    const landFact = this.runFacts.append(run.id, landFactType, { ...landProjection }, now());
    this.journal.writePonc(run.id, landFact.seq, now());

    const timeoutMs = this.opts.timeoutMs ?? LANDING_OP_TIMEOUT_MS;
    for (const effect of effects) {
      this.journal.recordIntent(
        run.id,
        { effect: effect.effect, idempotencyKey: effect.idempotencyKey, expected: effect.expected },
        now(),
      );
      const result = await withTimeout(effect.apply, timeoutMs, effect.effect);
      this.journal.recordResult(
        run.id,
        { effect: effect.effect, idempotencyKey: effect.idempotencyKey, ok: result.ok, observed: result.observed, detail: result.detail },
        now(),
      );
      if (!result.ok) {
        // Non-interruptible does NOT mean "can't fail" — it means a FAILED
        // effect leaves the Task in the same awaiting-review limbo today's
        // merge-conflict path already uses, rather than a half-settled Run.
        // Whatever already applied before this effect stays applied and
        // journaled; nothing here retries.
        return { ok: false, detail: result.detail };
      }
    }

    this.settle.settle(task, run, landFactType, landProjection, patch);
    return { ok: true };
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
    const rows = this.journal.views(run.id);
    const actions = reconcile(rows, observed);
    for (const action of actions) {
      if (action.action === 'already-applied') continue;
      if (action.action === 'adopt') {
        // The world already shows this effect done — record it as such
        // WITHOUT running `apply` again (the whole point: no duplicate
        // merge/PR/close, no false conflict against work that already landed).
        this.journal.recordResult(run.id, { effect: action.effect, idempotencyKey: action.key, ok: true, observed: { adopted: true } });
        continue;
      }
      // action === 'apply': genuinely never happened (or definitively failed
      // and left no trace) — safe, and necessary, to run it for real.
      const executor = executors[action.effect];
      if (!executor) continue; // no executor supplied — leave pending
      const intentRow = rows.find((r) => r.kind === 'intent' && r.idempotencyKey === action.key);
      const expected = (intentRow?.payload['expected'] as Record<string, unknown> | undefined) ?? {};
      const result = await executor(action.key, expected);
      this.journal.recordResult(run.id, { effect: action.effect, idempotencyKey: action.key, ok: result.ok, observed: result.observed, detail: result.detail });
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
