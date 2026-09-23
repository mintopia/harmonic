import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { TaskService } from '../src/domain/tasks.js';
import { TurnCompletion, type TurnCompletionDeps } from '../src/execution/turn-completion.js';
import type { ActiveRun } from '../src/execution/active-runs.js';
import type { TurnListeners } from '../src/execution/turn-listeners.js';
import type { VerificationCoordinator } from '../src/execution/verification-coordinator.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';

describe('an unresolved auto-driven attempt fails its implementation step (issue: failed attempt shows a completed step)', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-attempt-lifecycle-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settingsStore));
    attempts = new AttemptStore(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the implementation step failed, not passed, when the agent never signalled finish and no verifier vouched for the work', async () => {
    const task = await tasks.create({ prompt: 'do the thing', state: 'ready' });
    const run = await attempts.create(task.id);
    const implementation = await attempts.createStep(run.id, { type: 'implementation', logLocator: 'session:pending' });
    await attempts.updateStep(implementation.id, { state: 'running', startedAt: Date.now() });

    // The same lambda turn-driver.ts wires as `advanceTask`: optimistically passes
    // the running implementation step on the way into verification.
    const advanceTask = async (to: 'verifying' | 'merging') => {
      const rows = await attempts.listSteps(run.id);
      const running = rows.find((row) => row.type === 'implementation' && row.state === 'running');
      if (to === 'verifying' && running) {
        await attempts.updateStep(running.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
      }
    };

    const deps: TurnCompletionDeps = {
      attempts,
      usage: { collectUsageSafe: async () => null } as unknown as TurnCompletionDeps['usage'],
      activeRuns: { setLastTurnContextTokens: () => {} } as unknown as TurnCompletionDeps['activeRuns'],
      mergeCoordinator: {} as unknown as TurnCompletionDeps['mergeCoordinator'],
      verification: {
        criticEnabledFor: async () => true,
        runVerification: async () => ({ decision: { outcome: 'proceed', reason: 'no verifiers configured' }, ran: false }),
      } as unknown as VerificationCoordinator,
      autoDrive: undefined,
      taskService: {} as unknown as TurnCompletionDeps['taskService'],
      getConfig: () => baselineConfig(),
      postMerge: undefined,
      isShuttingDown: () => false,
      settleEscalated: async () => {},
      settleAutoCompleted: async () => {},
      diffSnapshotFor: async () => ({ stat: null, diffBaseOid: null, diffHeadOid: null }),
      worktreePathForTask: () => { throw new Error('not a worktree task in this test'); },
      updateStep: (_taskId, id, patch) => attempts.updateStep(id, patch),
    };
    const completion = new TurnCompletion(deps);

    const active = {
      agentFinished: false,
      externallySettled: false,
      verifyAbort: new AbortController(),
    } as unknown as ActiveRun;
    const listeners = { stoppedShort: null } as unknown as TurnListeners;

    const outcome = await completion.finishDrivenTurn({
      task,
      run,
      harness: {} as unknown as Parameters<TurnCompletion['finishDrivenTurn']>[0]['harness'],
      parent: {} as unknown as Parameters<TurnCompletion['finishDrivenTurn']>[0]['parent'],
      workspace: { cwd: dir, env: {} },
      active,
      listeners,
      autoDriven: true,
      attemptNumber: 1,
      driven: { result: {}, connectionGone: false, escalating: null },
      record: () => {},
      finalize: async () => {},
      advanceTask,
    });

    expect(outcome).toMatchObject({ kind: 'actionable-fail', reason: 'attempt ended without an execution-complete (finish_task) signal' });
    const steps = await attempts.listSteps(run.id);
    expect(steps.find((step) => step.type === 'implementation')).toMatchObject({ state: 'failed' });
  });
});

describe('AttemptStore.markInterrupted also fails an orphaned attempt\'s still-running steps', () => {
  let dir: string;
  let db: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-steps-'));
    db = await openAsyncDb(dir);
    await seedWorkspace(db);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(db, () => baselineConfig(), allWorkspaces(db, settingsStore));
    attempts = new AttemptStore(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the orphaned running attempt and closes its running step, leaving passed steps untouched', async () => {
    const task = await tasks.create({ prompt: 'crash mid-implementation', state: 'ready' });
    const run = await attempts.create(task.id);
    const rebase = await attempts.createStep(run.id, { type: 'rebase' });
    await attempts.updateStep(rebase.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() - 1000 });
    const implementation = await attempts.createStep(run.id, { type: 'implementation', logLocator: 'session:pending' });
    await attempts.updateStep(implementation.id, { state: 'running', startedAt: Date.now() });

    const orphans = await attempts.markInterrupted();

    expect(orphans.map((attempt) => attempt.id)).toEqual([run.id]);
    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
    const steps = await attempts.listSteps(run.id);
    expect(steps).toMatchObject([
      { type: 'rebase', state: 'passed' },
      { type: 'implementation', state: 'failed' },
    ]);
    expect(steps.find((step) => step.type === 'implementation')?.endedAt).not.toBeNull();
  });
});
