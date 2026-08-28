import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { MergeJournalStore } from '../src/domain/merge-journal.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import { MergeCoordinator, type MergeEffectExec, type MergeEffectOutcome } from '../src/domain/merge-coordinator.js';
import { EscalationService } from '../src/domain/escalation.js';
import type { SettleProjection } from '../src/domain/run-coordinator.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

/** The merge projection every merging intends: the Run completed, the ticket done. */
const MERGE_PROJECTION: SettleProjection = { runState: 'completed', taskAction: 'done', reason: null };
const CANCEL_PROJECTION: SettleProjection = { runState: 'cancelled', taskAction: 'none', reason: null };

/**
 * The AC harness for issue #115: `MergeCoordinator.merge`/`reconcileMerge`
 * exercised against the real stores over a real (temp) sqlite DB — the PONC
 * freeze is a genuine race between two independent `RunSettleCoordinator`
 * writers over the same Run row, so this needs the real store discipline
 * (monotonic seq, unique index), not a hand-rolled fake.
 */
describe('MergeCoordinator (issue #115)', () => {
  let dir: string;
  // These stores (RunStore, TaskService, leases, RunFactStore, MergeJournalStore)
  // are all on the async libsql Db (ADR-0029; merging journal migrated in #209).
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runStore: RunStore;
  let leases: WorkContextLeaseStore;
  let runFacts: RunFactStore;
  let journal: MergeJournalStore;
  let settle: RunSettleCoordinator;
  let coordinator: MergeCoordinator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-merge-coordinator-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    runStore = new RunStore(asyncDb);
    leases = new WorkContextLeaseStore(asyncDb);
    runFacts = new RunFactStore(asyncDb);
    journal = new MergeJournalStore(asyncDb);
    settle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, journal);
    coordinator = new MergeCoordinator(runStore, asyncDb, journal, settle);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A Task+Run pair where an operator Accept finds them: the ticket
   * `escalated`, its Run still `running` past verification (the live shape a
   * merging settles from). */
  async function fixture(): Promise<{ task: TaskRow; run: RunRow }> {
    const created = await tasks.create({ prompt: 'merge me', state: 'ready' });
    await tasks.setState(created.id, 'working');
    let run = await runStore.create(created.id);
    run = await runStore.update(run.id, { phase: 'verifying', candidateOid: 'a'.repeat(40) });
    await tasks.escalate(created.id, 'escalated to human: attempt 2 of 2 failed');
    return { task: await tasks.get(created.id), run };
  }

  function ok(observed: Record<string, unknown> = {}): Promise<MergeEffectOutcome> {
    return Promise.resolve({ ok: true, observed });
  }

  it('each effect writes intent -> apply -> result, keyed by idempotency identity', async () => {
    const { task, run } = await fixture();
    let applied = 0;
    const effect: MergeEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@deadbeef',
      expected: { branch: 'harmonic/task-1-run-1' },
      apply: async () => {
        applied++;
        return ok({ mergedOid: 'deadbeef' });
      },
    };

    const outcome = await coordinator.merge(task, run, MERGE_PROJECTION, [effect]);
    expect(outcome).toEqual({ ok: true });
    expect(applied).toBe(1);

    const rows = await journal.views(run.id);
    expect(rows.map((r) => r.kind)).toEqual(['ponc', 'intent', 'result']);
    const [poncRow, intentRow, resultRow] = rows;
    expect(intentRow).toMatchObject({ effect: 'target-ref', idempotencyKey: 'main@deadbeef', payload: { expected: { branch: 'harmonic/task-1-run-1' } } });
    expect(resultRow).toMatchObject({ effect: 'target-ref', idempotencyKey: 'main@deadbeef', payload: { ok: true, observed: { mergedOid: 'deadbeef' } } });
    expect(poncRow!.payload['cutoffSeq']).toEqual(expect.any(Number));

    // The Run actually merged.
    const mergedRun = await runStore.get(run.id);
    expect(mergedRun.state).toBe('completed');
    expect(mergedRun.phase).toBe('terminal');
    expect((await tasks.get(task.id)).state).toBe('done');
  });

  it('a merge-conflict-style failure stops the loop, abandons the merging (PONC lifted), and leaves the Task escalated', async () => {
    const { task, run } = await fixture();
    const effect: MergeEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@conflict',
      expected: {},
      apply: async () => ({ ok: false, detail: 'merge conflict' }),
    };

    const outcome = await coordinator.merge(task, run, MERGE_PROJECTION, [effect]);
    expect(outcome).toEqual({ ok: false, detail: 'merge conflict' });

    // Nothing settled: the Run never left `running`, the Task never left
    // `escalated`, and the Run is back in the phase it was found in.
    expect(await runStore.get(run.id)).toMatchObject({ state: 'running', phase: 'verifying' });
    expect((await tasks.get(task.id)).state).toBe('escalated');

    const rows = await journal.views(run.id);
    expect(rows.map((r) => r.kind)).toEqual(['ponc', 'intent', 'result', 'abandoned']);
    expect(rows[2]).toMatchObject({ payload: { ok: false, detail: 'merge conflict' } });
    // The PONC no longer freezes the disposition: an escalate fact appended
    // after the abandoned merging decides the Run instead of the merge fact.
    expect(await journal.ponc(run.id)).toBeNull();
    await settle.settle(task, run, 'escalate', { runState: 'failed', taskAction: 'escalate', reason: 'escalated to human: merging failed' });
    expect(await runStore.get(run.id)).toMatchObject({ state: 'failed', phase: 'terminal' });
  });

  it('a cancel fact appended after the PONC is audit-only: the merge still wins and settles the Run "completed"', async () => {
    const { task, run } = await fixture();
    let resolveApply!: (v: MergeEffectOutcome) => void;
    const effect: MergeEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@race',
      expected: {},
      apply: () => new Promise<MergeEffectOutcome>((resolve) => (resolveApply = resolve)),
    };

    const mergePromise = coordinator.merge(task, run, MERGE_PROJECTION, [effect]);

    // Mid-merging: an operator-cancel races in on a SEPARATE settle call —
    // exactly the scenario the PONC exists for. It must not be able to flip
    // the Run to cancelled once the merge fact is frozen in.
    await settle.settle(task, run, 'operator-cancel', CANCEL_PROJECTION);

    // The racing cancel's OWN settle call is forced by the PONC clamp to see
    // the merge fact (already at/under the frozen cutoff) as decisive — the
    // Run is merged by the time the cancel's settle call returns.
    const afterCancelRace = await runStore.get(run.id);
    expect(afterCancelRace.state).toBe('completed');
    expect(afterCancelRace.phase).toBe('terminal');
    expect((await tasks.get(task.id)).state).toBe('done');

    // The cancel fact is still in the log — audit, not decisive.
    const cancelFacts = (await runFacts.list(run.id)).filter((f) => f.type === 'operator-cancel');
    expect(cancelFacts).toHaveLength(1);

    // The effect now finishes; `merge`'s own deferred settle call idempotently
    // no-ops (the Run is already terminal).
    resolveApply({ ok: true, observed: {} });
    const outcome = await mergePromise;
    expect(outcome).toEqual({ ok: true });
    expect((await runStore.get(run.id)).state).toBe('completed'); // unchanged, still merged
  });

  it('a cancel racing through a SEPARATE PONC-aware coordinator (the Runner\'s) is still audit-only', async () => {
    // Regression for the cross-instance race (issue #115 review): in production
    // the operator-cancel path travels through `Runner.settleCoordinator`, a
    // DIFFERENT `RunSettleCoordinator` instance than the review-side one that
    // drives `merge`. Both must honour the same PONC, which they do only because
    // both are handed a `MergeJournalStore` over the same DB. This builds that
    // second instance exactly as the Runner does and races the cancel through
    // it — the merge must still win. (Without the Runner-side journal wiring,
    // this cancel would flip the Run to `cancelled` and "un-merge" a merge.)
    const runnerSettle = new RunSettleCoordinator(runStore, tasks, leases, runFacts, undefined, new MergeJournalStore(asyncDb));

    const { task, run } = await fixture();
    let resolveApply!: (v: MergeEffectOutcome) => void;
    const effect: MergeEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@cross-instance',
      expected: {},
      apply: () => new Promise<MergeEffectOutcome>((resolve) => (resolveApply = resolve)),
    };

    const mergePromise = coordinator.merge(task, run, MERGE_PROJECTION, [effect]);

    // The cancel arrives through the Runner's own coordinator instance.
    await runnerSettle.settle(task, run, 'operator-cancel', CANCEL_PROJECTION);

    const afterCancel = await runStore.get(run.id);
    expect(afterCancel.state).toBe('completed');
    expect(afterCancel.phase).toBe('terminal');
    expect((await tasks.get(task.id)).state).toBe('done');
    expect((await runFacts.list(run.id)).filter((f) => f.type === 'operator-cancel')).toHaveLength(1);

    resolveApply({ ok: true, observed: {} });
    expect(await mergePromise).toEqual({ ok: true });
    expect((await runStore.get(run.id)).state).toBe('completed');
  });

  it('simulated mid-merging crash: intent written, no result — a fresh coordinator reconciles', async () => {
    const { run } = await fixture();
    // Simulate the crash directly against the journal: `merge` got as far as
    // recording intent for the merge but the process died before `apply()`
    // resolved (or before the result was recorded) — no result row exists.
    await journal.writePonc(run.id, (await runFacts.append(run.id, 'agent-finish/unresolved', { ...MERGE_PROJECTION })).seq);
    await journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey: 'main@crash', expected: { branch: 'harmonic/task-1-run-1' } });

    // A FRESH coordinator instance — the "restarted process" — reconciles.
    const freshCoordinator = new MergeCoordinator(runStore, asyncDb, journal, settle);

    // Case 1: the world shows the effect already happened (the merge merged
    // just before the crash) -> adopt: record the result, do NOT re-apply.
    let reapplyCount = 0;
    const adoptActions = await freshCoordinator.reconcileMerge(
      run,
      () => 'present',
      { 'target-ref': async () => { reapplyCount++; return { ok: true }; } },
    );
    expect(adoptActions).toEqual([{ effect: 'target-ref', key: 'main@crash', action: 'adopt' }]);
    expect(reapplyCount).toBe(0); // never re-ran the effect
    expect((await journal.views(run.id)).at(-1)).toMatchObject({ kind: 'result', effect: 'target-ref', idempotencyKey: 'main@crash', payload: { ok: true } });
  });

  it('simulated mid-merging crash with observed=absent -> apply exactly once', async () => {
    const { run } = await fixture();
    await journal.writePonc(run.id, (await runFacts.append(run.id, 'agent-finish/unresolved', { ...MERGE_PROJECTION })).seq);
    await journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey: 'main@crash2', expected: {} });

    const freshCoordinator = new MergeCoordinator(runStore, asyncDb, journal, settle);
    let applyCount = 0;
    const actions = await freshCoordinator.reconcileMerge(
      run,
      () => 'absent',
      { 'target-ref': async () => { applyCount++; return { ok: true, observed: { mergedOid: 'cafe' } }; } },
    );
    expect(actions).toEqual([{ effect: 'target-ref', key: 'main@crash2', action: 'apply' }]);
    expect(applyCount).toBe(1);
    expect((await journal.views(run.id)).at(-1)).toMatchObject({ kind: 'result', payload: { ok: true, observed: { mergedOid: 'cafe' } } });
  });

  it('an operator-accept merge (issue #191) settles under `operator-accept`, not the default `agent-finish/unresolved`', async () => {
    const { task, run } = await fixture();
    const outcome = await coordinator.merge(task, run, MERGE_PROJECTION, [], {}, 'operator-accept');
    expect(outcome).toEqual({ ok: true });
    expect((await runStore.get(run.id)).state).toBe('completed');
    const types = (await runFacts.list(run.id)).map((f) => f.type);
    expect(types).toContain('operator-accept');
    expect(types).not.toContain('agent-finish/unresolved');
  });

  it('a failed operator Accept leaves the ticket escalated and its settled Run terminal — no run slot consumed (issue #270)', async () => {
    const { task } = await fixture();
    // The real shape: the escalated ticket's Run already settled `failed`.
    let run = (await runStore.listForTask(task.id))[0]!;
    await settle.settle(task, run, 'escalate', { runState: 'failed', taskAction: 'escalate', reason: 'escalated to human: attempt 2 of 2 failed' });
    run = await runStore.get(run.id);
    expect(run).toMatchObject({ state: 'failed', phase: 'terminal' });
    const escalation = new EscalationService(
      runStore,
      tasks,
      coordinator,
      () => [{
        effect: 'target-ref',
        idempotencyKey: 'main@dirty-target',
        expected: {},
        apply: async () => ({ ok: false, detail: 'target branch has uncommitted changes; merge via PR/manual' }),
      }],
      { resume: async () => {}, cleanup: async () => {} },
    );

    await expect(escalation.accept(task.id)).rejects.toThrow('target branch has uncommitted changes');

    expect(await runStore.get(run.id)).toMatchObject({ state: 'failed', phase: 'terminal' });
    expect((await tasks.get(task.id)).state).toBe('escalated');
    expect((await journal.views(run.id)).map((r) => r.kind)).toEqual(['ponc', 'intent', 'result', 'abandoned']);
    expect(await runStore.countRunning()).toBe(0);
  });

  it('an operator-accept loses to a racing operator-cancel appended BEFORE the merge\'s PONC (issue #191)', async () => {
    const { task, run } = await fixture();
    // The cancel is already settled on this Run's log before `merge` is ever
    // called — e.g. a cancel that raced in and fully resolved just ahead of
    // the operator's accept request reaching this coordinator.
    await settle.settle(task, run, 'operator-cancel', CANCEL_PROJECTION);
    expect((await runStore.get(run.id)).state).toBe('cancelled');

    const outcome = await coordinator.merge(task, run, MERGE_PROJECTION, [], {}, 'operator-accept');
    expect(outcome).toEqual({ ok: true }); // effects still applied; the loop doesn't check prior disposition
    // But the disposition replay still finds the earlier, higher-precedence
    // operator-cancel fact within the frozen PONC window — the accept cannot
    // flip the Run back to completed.
    expect((await runStore.get(run.id)).state).toBe('cancelled');
    expect((await tasks.get(task.id)).state).toBe('escalated'); // taskAction 'none' on cancel left it here
  });

  it('an operator-accept still wins over a cancel appended AFTER the merge\'s PONC (issue #191)', async () => {
    const { task, run } = await fixture();
    let resolveApply!: (v: MergeEffectOutcome) => void;
    const effect: MergeEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@accept-race',
      expected: {},
      apply: () => new Promise<MergeEffectOutcome>((resolve) => (resolveApply = resolve)),
    };

    const mergePromise = coordinator.merge(task, run, MERGE_PROJECTION, [effect], {}, 'operator-accept');

    // Mid-merging: a cancel races in on a separate settle call, after this
    // merge's PONC has already frozen the cutoff at the operator-accept fact.
    await settle.settle(task, run, 'operator-cancel', CANCEL_PROJECTION);

    const afterCancelRace = await runStore.get(run.id);
    expect(afterCancelRace.state).toBe('completed');
    expect(afterCancelRace.phase).toBe('terminal');
    expect((await tasks.get(task.id)).state).toBe('done');

    resolveApply({ ok: true, observed: {} });
    expect(await mergePromise).toEqual({ ok: true });
    expect((await runStore.get(run.id)).state).toBe('completed'); // unchanged, still merged
  });

  it('reconcile after a completed merging is a no-op (all already-applied, no executor calls)', async () => {
    const { task, run } = await fixture();
    let applied = 0;
    const effect: MergeEffectExec = {
      effect: 'target-ref',
      idempotencyKey: 'main@done',
      expected: {},
      apply: async () => { applied++; return ok(); },
    };
    await coordinator.merge(task, run, MERGE_PROJECTION, [effect]);
    expect(applied).toBe(1);

    const before = (await journal.list(run.id)).length;
    const actions = await coordinator.reconcileMerge(run, () => 'present', {
      'target-ref': async () => { applied++; return ok(); },
    });
    expect(actions).toEqual([{ effect: 'target-ref', key: 'main@done', action: 'already-applied' }]);
    expect(applied).toBe(1); // never re-applied
    expect((await journal.list(run.id)).length).toBe(before); // nothing new written — a true no-op
  });
});
