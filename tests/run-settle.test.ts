import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';

/**
 * `RunSettleCoordinator.settle` as a guarded state transition (ADR-0001 #388
 * S-E/S-G): the append-only `run_facts` log + precedence replay is gone, and
 * Attempt is the single execution ledger (no separate Run row) — a
 * disposition is applied directly to the Attempt, guarded to only move it out
 * of `running` (mirroring `AttemptStore.finish`/`markInterrupted`'s
 * `WHERE state='running'` discipline), with the one explicit exception that an
 * operator disposition (`operator-cancel` / `operator-accept`) may also act on
 * an already-`escalated` Attempt. Everything else is first-writer-wins.
 */
describe('RunSettleCoordinator.settle — guarded state transition', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;
  let settle: RunSettleCoordinator;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-run-settle-'));
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
    settle = new RunSettleCoordinator(tasks, attempts);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A `working` Task with a `running` Attempt. */
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
    // taskAction 'ready' requeues a still-`working` Task.
    expect((await tasks.get(task.id)).state).toBe('ready');
  });

  it('(iii) a second racing settle on an already-terminal Attempt is a no-op', async () => {
    const { task, run } = await runningTask();
    await settle.settle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: 'boom' });
    const settledAttempt = await attempts.get(run.id);

    // A straggler racing signal — even one that would have outranked 'failed'
    // under the old fact-log precedence (e.g. 'escalate') — arrives after the
    // Attempt already left `running`. It is not an operator override, so it
    // no-ops entirely: the Attempt and the Task action are untouched.
    await settle.settle(await tasks.get(task.id), run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: 'escalated to human: too late',
    });

    expect(await attempts.get(run.id)).toEqual(settledAttempt);
    // The Task stayed 'ready' from the first settle's taskAction — the second
    // settle's 'escalate' taskAction never applied.
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

    // Close: taskAction 'none' leaves the Task to its own cancel call (the
    // caller — EscalationService.close/Runner.cancelForTask — transitions the
    // Task through TaskService directly); settle only owns the Attempt.
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
    // The free-text detail lands on the Task's escalationReason (unaffected by
    // this refactor); attempts.reason is the cheap, low-cardinality kind.
    expect(attempt).toMatchObject({ state: 'escalated', reason: 'guardrail-trip' });
    expect((await tasks.get(task.id)).escalationReason).toBe('escalated to human: wall-clock budget exceeded');
  });
});
