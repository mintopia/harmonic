import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { LandingJournalStore } from '../src/domain/landing-journal.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import { LandingCoordinator, type LandingEffectExec, type LandingEffectOutcome } from '../src/domain/landing-coordinator.js';
import type { SettleProjection } from '../src/domain/run-coordinator.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import { allWorkspaces } from './helpers.js';

/** The land projection every accept-path landing intends (mirrors
 * ReviewService.accept's pre-#115 direct settle call). */
const LAND_PROJECTION: SettleProjection = { runState: 'completed', taskAction: 'completed', reason: null };
const CANCEL_PROJECTION: SettleProjection = { runState: 'cancelled', taskAction: 'none', reason: null };

/**
 * The AC harness for issue #115: `LandingCoordinator.land`/`reconcileLanding`
 * exercised against the real stores over a real (temp) sqlite DB — the PONC
 * freeze is a genuine race between two independent `RunSettleCoordinator`
 * writers over the same Run row, so this needs the real store discipline
 * (monotonic seq, unique index), not a hand-rolled fake.
 */
describe('LandingCoordinator (issue #115)', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let runStore: RunStore;
  let leases: WorkContextLeaseStore;
  let runFacts: RunFactStore;
  let journal: LandingJournalStore;
  let settle: RunSettleCoordinator;
  let coordinator: LandingCoordinator;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-landing-coordinator-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runStore = new RunStore(db);
    leases = new WorkContextLeaseStore(db);
    runFacts = new RunFactStore(db);
    journal = new LandingJournalStore(db);
    settle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, journal);
    coordinator = new LandingCoordinator(runStore, runFacts, journal, settle);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A Task+Run pair parked exactly where `land` expects to find them: Task
   * `awaiting-review`, Run `running` in `phase:'review'` — the state
   * `ReviewService.accept` hands off in. */
  function fixture(): { task: TaskRow; run: RunRow } {
    const created = tasks.create({ prompt: 'land me', state: 'ready' });
    tasks.setState(created.id, 'running');
    let run = runStore.create(created.id);
    run = runStore.update(run.id, { phase: 'review' });
    tasks.setState(created.id, 'awaiting-review');
    return { task: tasks.get(created.id), run };
  }

  function ok(observed: Record<string, unknown> = {}): Promise<LandingEffectOutcome> {
    return Promise.resolve({ ok: true, observed });
  }

  it('each effect writes intent -> apply -> result, keyed by idempotency identity', async () => {
    const { task, run } = fixture();
    let applied = 0;
    const effect: LandingEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@deadbeef',
      expected: { branch: 'harmonic/task-1-run-1' },
      apply: async () => {
        applied++;
        return ok({ mergedOid: 'deadbeef' });
      },
    };

    const outcome = await coordinator.land(task, run, LAND_PROJECTION, [effect]);
    expect(outcome).toEqual({ ok: true });
    expect(applied).toBe(1);

    const rows = journal.views(run.id);
    expect(rows.map((r) => r.kind)).toEqual(['ponc', 'intent', 'result']);
    const [poncRow, intentRow, resultRow] = rows;
    expect(intentRow).toMatchObject({ effect: 'target-ref', idempotencyKey: 'main@deadbeef', payload: { expected: { branch: 'harmonic/task-1-run-1' } } });
    expect(resultRow).toMatchObject({ effect: 'target-ref', idempotencyKey: 'main@deadbeef', payload: { ok: true, observed: { mergedOid: 'deadbeef' } } });
    expect(poncRow!.payload['cutoffSeq']).toEqual(expect.any(Number));

    // The Run actually landed.
    const landedRun = runStore.get(run.id);
    expect(landedRun.state).toBe('completed');
    expect(landedRun.phase).toBe('terminal');
    expect(tasks.get(task.id).state).toBe('completed');
  });

  it('a merge-conflict-style failure stops the loop and leaves the Task awaiting-review (unsettled)', async () => {
    const { task, run } = fixture();
    const effect: LandingEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@conflict',
      expected: {},
      apply: async () => ({ ok: false, detail: 'merge conflict' }),
    };

    const outcome = await coordinator.land(task, run, LAND_PROJECTION, [effect]);
    expect(outcome).toEqual({ ok: false, detail: 'merge conflict' });

    // Nothing settled: the Run never left `running`, the Task never left
    // `awaiting-review` — exactly today's merge-conflict behaviour.
    expect(runStore.get(run.id).state).toBe('running');
    expect(tasks.get(task.id).state).toBe('awaiting-review');

    const rows = journal.views(run.id);
    expect(rows.map((r) => r.kind)).toEqual(['ponc', 'intent', 'result']);
    expect(rows[2]).toMatchObject({ payload: { ok: false, detail: 'merge conflict' } });
  });

  it('a cancel fact appended after the PONC is audit-only: the land still wins and settles the Run "completed"', async () => {
    const { task, run } = fixture();
    let resolveApply!: (v: LandingEffectOutcome) => void;
    const effect: LandingEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@race',
      expected: {},
      apply: () => new Promise<LandingEffectOutcome>((resolve) => (resolveApply = resolve)),
    };

    const landPromise = coordinator.land(task, run, LAND_PROJECTION, [effect]);

    // Mid-landing: an operator-cancel races in on a SEPARATE settle call —
    // exactly the scenario the PONC exists for. It must not be able to flip
    // the Run to cancelled once the land fact is frozen in.
    settle.settle(task, run, 'operator-cancel', CANCEL_PROJECTION);

    // The racing cancel's OWN settle call is forced by the PONC clamp to see
    // the land fact (already at/under the frozen cutoff) as decisive — the
    // Run is landed by the time the cancel's settle call returns.
    const afterCancelRace = runStore.get(run.id);
    expect(afterCancelRace.state).toBe('completed');
    expect(afterCancelRace.phase).toBe('terminal');
    expect(tasks.get(task.id).state).toBe('completed');

    // The cancel fact is still in the log — audit, not decisive.
    const cancelFacts = runFacts.list(run.id).filter((f) => f.type === 'operator-cancel');
    expect(cancelFacts).toHaveLength(1);

    // The effect now finishes; `land`'s own deferred settle call idempotently
    // no-ops (the Run is already terminal).
    resolveApply({ ok: true, observed: {} });
    const outcome = await landPromise;
    expect(outcome).toEqual({ ok: true });
    expect(runStore.get(run.id).state).toBe('completed'); // unchanged, still landed
  });

  it('a cancel racing through a SEPARATE PONC-aware coordinator (the Runner\'s) is still audit-only', async () => {
    // Regression for the cross-instance race (issue #115 review): in production
    // the operator-cancel path travels through `Runner.settleCoordinator`, a
    // DIFFERENT `RunSettleCoordinator` instance than the review-side one that
    // drives `land`. Both must honour the same PONC, which they do only because
    // both are handed a `LandingJournalStore` over the same DB. This builds that
    // second instance exactly as the Runner does and races the cancel through
    // it — the land must still win. (Without the Runner-side journal wiring,
    // this cancel would flip the Run to `cancelled` and "un-land" a merge.)
    const runnerSettle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, new LandingJournalStore(db));

    const { task, run } = fixture();
    let resolveApply!: (v: LandingEffectOutcome) => void;
    const effect: LandingEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@cross-instance',
      expected: {},
      apply: () => new Promise<LandingEffectOutcome>((resolve) => (resolveApply = resolve)),
    };

    const landPromise = coordinator.land(task, run, LAND_PROJECTION, [effect]);

    // The cancel arrives through the Runner's own coordinator instance.
    runnerSettle.settle(task, run, 'operator-cancel', CANCEL_PROJECTION);

    const afterCancel = runStore.get(run.id);
    expect(afterCancel.state).toBe('completed');
    expect(afterCancel.phase).toBe('terminal');
    expect(tasks.get(task.id).state).toBe('completed');
    expect(runFacts.list(run.id).filter((f) => f.type === 'operator-cancel')).toHaveLength(1);

    resolveApply({ ok: true, observed: {} });
    expect(await landPromise).toEqual({ ok: true });
    expect(runStore.get(run.id).state).toBe('completed');
  });

  it('simulated mid-landing crash: intent written, no result — a fresh coordinator reconciles', async () => {
    const { run } = fixture();
    // Simulate the crash directly against the journal: `land` got as far as
    // recording intent for the merge but the process died before `apply()`
    // resolved (or before the result was recorded) — no result row exists.
    journal.writePonc(run.id, runFacts.append(run.id, 'agent-finish/unresolved', { ...LAND_PROJECTION }).seq);
    journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey: 'main@crash', expected: { branch: 'harmonic/task-1-run-1' } });

    // A FRESH coordinator instance — the "restarted process" — reconciles.
    const freshCoordinator = new LandingCoordinator(runStore, runFacts, journal, settle);

    // Case 1: the world shows the effect already happened (the merge landed
    // just before the crash) -> adopt: record the result, do NOT re-apply.
    let reapplyCount = 0;
    const adoptActions = await freshCoordinator.reconcileLanding(
      run,
      () => 'present',
      { 'target-ref': async () => { reapplyCount++; return { ok: true }; } },
    );
    expect(adoptActions).toEqual([{ effect: 'target-ref', key: 'main@crash', action: 'adopt' }]);
    expect(reapplyCount).toBe(0); // never re-ran the effect
    expect(journal.views(run.id).at(-1)).toMatchObject({ kind: 'result', effect: 'target-ref', idempotencyKey: 'main@crash', payload: { ok: true } });
  });

  it('simulated mid-landing crash with observed=absent -> apply exactly once', async () => {
    const { run } = fixture();
    journal.writePonc(run.id, runFacts.append(run.id, 'agent-finish/unresolved', { ...LAND_PROJECTION }).seq);
    journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey: 'main@crash2', expected: {} });

    const freshCoordinator = new LandingCoordinator(runStore, runFacts, journal, settle);
    let applyCount = 0;
    const actions = await freshCoordinator.reconcileLanding(
      run,
      () => 'absent',
      { 'target-ref': async () => { applyCount++; return { ok: true, observed: { mergedOid: 'cafe' } }; } },
    );
    expect(actions).toEqual([{ effect: 'target-ref', key: 'main@crash2', action: 'apply' }]);
    expect(applyCount).toBe(1);
    expect(journal.views(run.id).at(-1)).toMatchObject({ kind: 'result', payload: { ok: true, observed: { mergedOid: 'cafe' } } });
  });

  it('reconcile after a completed landing is a no-op (all already-applied, no executor calls)', async () => {
    const { task, run } = fixture();
    let applied = 0;
    const effect: LandingEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@done',
      expected: {},
      apply: async () => { applied++; return ok(); },
    };
    await coordinator.land(task, run, LAND_PROJECTION, [effect]);
    expect(applied).toBe(1);

    const before = journal.list(run.id).length;
    const actions = await coordinator.reconcileLanding(run, () => 'present', {
      'target-ref': async () => { applied++; return ok(); },
    });
    expect(actions).toEqual([{ effect: 'target-ref', key: 'main@done', action: 'already-applied' }]);
    expect(applied).toBe(1); // never re-applied
    expect(journal.list(run.id).length).toBe(before); // nothing new written — a true no-op
  });
});
