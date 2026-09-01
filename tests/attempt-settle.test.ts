import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { AttemptSettleCoordinator } from '../src/domain/attempt-settle.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

describe('AttemptSettleCoordinator.settle — guarded state transition', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let settle: AttemptSettleCoordinator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-run-settle-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    settle = new AttemptSettleCoordinator(tasks, attempts);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function runningTask() {
    const task = await tasks.create({ prompt: 'p', state: 'ready' });
    await tasks.setState(task.id, 'working');
    const run = await attempts.create(task.id);
    return { task: await tasks.get(task.id), run };
  }

  it('(i) the first ending signal wins on a running Attempt, and writes attempts.reason to the ending kind', async () => {
    const { task, run } = await runningTask();

    await settle.settle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'boom' });

    const attempt = await attempts.get(run.id);
    expect(attempt).toMatchObject({ state: 'failed', reason: 'failed' });
    expect((await tasks.get(task.id)).state).toBe('ready');
  });

  it('(iii) a second racing settle on an already-terminal Attempt is a no-op', async () => {
    const { task, run } = await runningTask();
    await settle.settle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'boom' });
    const settledAttempt = await attempts.get(run.id);

    await settle.settle(await tasks.get(task.id), run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: too late',
    });

    expect(await attempts.get(run.id)).toEqual(settledAttempt);
    expect((await tasks.get(task.id)).state).toBe('ready');
  });

  it('(ii) operator-accept overrides an already-escalated Attempt, moving it to passed', async () => {
    const { task, run } = await runningTask();
    await settle.settle(task, run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: attempt 1 of 1 failed',
    });
    expect((await tasks.get(task.id)).state).toBe('escalated');
    const escalatedAttempt = await attempts.get(run.id);
    expect(escalatedAttempt).toMatchObject({ state: 'escalated', reason: 'escalate' });

    await settle.settle(await tasks.get(task.id), await attempts.get(run.id), 'operator-accept', {
      runState: 'completed',
      taskAction: 'done',
      reason: null,
    });

    const acceptedAttempt = await attempts.get(run.id);
    expect(acceptedAttempt).toMatchObject({ state: 'passed', reason: 'operator-accept' });
    expect((await tasks.get(task.id)).state).toBe('done');
  });

  it('(ii) operator-cancel overrides an already-escalated Attempt, moving it to cancelled', async () => {
    const { task, run } = await runningTask();
    await settle.settle(task, run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: attempt 1 of 1 failed',
    });

    await settle.settle(await tasks.get(task.id), await attempts.get(run.id), 'operator-cancel', {
      runState: 'cancelled',
      taskAction: 'none',
      reason: null,
    });

    const cancelledAttempt = await attempts.get(run.id);
    expect(cancelledAttempt).toMatchObject({ state: 'cancelled', reason: 'operator-cancel' });
  });

  it('(iv) attempts.reason records the ending kind across every disposition, not free-text detail', async () => {
    const { task, run } = await runningTask();
    await settle.settle(task, run, 'guardrail-trip', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: wall-clock budget exceeded',
    });
    const attempt = await attempts.get(run.id);
    expect(attempt).toMatchObject({ state: 'escalated', reason: 'guardrail-trip' });
    expect((await tasks.get(task.id)).escalationReason).toBe('escalated to human: wall-clock budget exceeded');
  });
});
