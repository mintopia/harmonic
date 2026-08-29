import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { RunFactStore } from '../src/domain/run-facts.js';
import { MergeJournalStore } from '../src/domain/merge-journal.js';
import { RunSettleCoordinator } from '../src/domain/run-settle.js';
import { MergeCoordinator } from '../src/domain/merge-coordinator.js';
import { TurnQueueStore } from '../src/domain/turn-queue-store.js';
import { CrashRecoveryCoordinator } from '../src/domain/crash-recovery.js';
import { Git } from '../src/execution/git.js';
import type { TaskRow, RunRow } from '../src/db/schema.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore } from './helpers.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README — mirrors
 * task-list-branch.test.ts's `makeRepo`. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/**
 * Direct unit coverage for `CrashRecoveryCoordinator`'s `opts.isMerged` /
 * `opts.now` injection seams (issue #117 review) — exercised hermetically
 * over a real (temp) sqlite DB, following the same store-construction idiom
 * as merge-coordinator.test.ts, rather than through the full HTTP server
 * boot path (boot-recovery.test.ts already covers that end-to-end).
 */
describe('CrashRecoveryCoordinator (issue #117, isMerged/now seams)', () => {
  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let runStore: RunStore;
  let runFacts: RunFactStore;
  let journal: MergeJournalStore;
  let settle: RunSettleCoordinator;
  let merging: MergeCoordinator;
  let turnQueue: TurnQueueStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-'));
    repo = makeRepo();
    asyncDb = await openAsyncDb(dir);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb, settingsStore));
    runStore = new RunStore(asyncDb);
    runFacts = new RunFactStore(asyncDb);
    journal = new MergeJournalStore(asyncDb);
    settle = new RunSettleCoordinator(runStore, tasks, runFacts, undefined, journal);
    merging = new MergeCoordinator(runStore, asyncDb, journal, settle);
    turnQueue = new TurnQueueStore(asyncDb);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A Task+Run pair parked mid-merging exactly as a crashed `merge()` would
   * leave them: Task `escalated`, Run `running`/`phase:'merging'`, with
   * a merge fact frozen (PONC) and an intent recorded for the `target-ref`
   * effect but NO result — died between intent and result. */
  async function seedMidMerge(branch: string, baseBranch: string): Promise<{ task: TaskRow; run: RunRow; idempotencyKey: string }> {
    const created = await tasks.create({ prompt: 'merge me', state: 'ready', workingDir: repo });
    await tasks.setState(created.id, 'working');
    let run = await runStore.create(created.id);
    run = await runStore.update(run.id, { phase: 'merging', branch, baseBranch });
    await tasks.setState(created.id, 'escalated');
    const task = await tasks.get(created.id);

    const idempotencyKey = `${baseBranch}<-${branch}`;
    const mergeFact = await runFacts.append(run.id, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'done', reason: null });
    await journal.writePonc(run.id, mergeFact.seq);
    await journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey, expected: { baseBranch, branch } });
    // No result row: the process died before `apply()` resolved.

    return { task, run, idempotencyKey };
  }

  it('adopts an already-merged effect when the world says merged: records a result without re-applying, and completes the Run (ADOPT path)', async () => {
    const branch = 'run-branch';
    const baseBranch = 'main';
    const { run, idempotencyKey } = await seedMidMerge(branch, baseBranch);

    const mergeSpy = vi.spyOn(Git, 'casUpdateRef');
    const isMerged = vi.fn(async () => true);
    const coord = new CrashRecoveryCoordinator(runStore, tasks, settle, merging, journal, turnQueue, {
      now: () => 1_000_000,
      isMerged,
    });

    await coord.reconcile();

    // isMerged was actually consulted (the injected seam, not the real Git.isAncestor).
    expect(isMerged).toHaveBeenCalledWith(repo, baseBranch, branch);
    // Adopted, never re-applied.
    expect(mergeSpy).not.toHaveBeenCalled();

    const rows = await journal.views(run.id);
    const result = rows.find((r) => r.kind === 'result' && r.idempotencyKey === idempotencyKey);
    expect(result).toMatchObject({ payload: { ok: true, observed: { adopted: true } } });

    const mergedRun = await runStore.get(run.id);
    expect(mergedRun.state).toBe('completed');
    expect(mergedRun.phase).toBe('terminal');
    expect((await tasks.get(run.taskId)).state).toBe('done');
  });

  it('escalates the ticket when the world says NOT merged and the real re-apply fails (no such branch to merge)', async () => {
    const branch = 'nonexistent-branch';
    const baseBranch = 'main';
    const { run } = await seedMidMerge(branch, baseBranch);

    const coord = new CrashRecoveryCoordinator(runStore, tasks, settle, merging, journal, turnQueue, {
      now: () => 1_000_000,
      isMerged: async () => false,
    });

    await coord.reconcile();

    // The re-apply genuinely failed (no such branch in the real repo) —
    // `foldJournal` shows not-all-ok, so the merging is abandoned (PONC lifted)
    // and the ticket escalates with the failure as its reason (trigger 3).
    const failedRun = await runStore.get(run.id);
    expect(failedRun.state).toBe('failed');
    expect(failedRun.phase).toBe('terminal');
    expect((await journal.views(run.id)).map((r) => r.kind)).toContain('abandoned');
    expect(await tasks.get(run.taskId)).toMatchObject({
      state: 'escalated',
      escalationReason: expect.stringContaining('merging failed after restart'),
    });
  });

  it('escalates a known failed merging without re-applying it (issue #270)', async () => {
    const branch = 'nonexistent-branch';
    const baseBranch = 'main';
    const { run, idempotencyKey } = await seedMidMerge(branch, baseBranch);
    await journal.recordResult(run.id, {
      effect: 'target-ref',
      idempotencyKey,
      ok: false,
      detail: 'target branch has uncommitted changes; merge via PR/manual',
    });
    const isMerged = vi.fn(async () => false);
    const coord = new CrashRecoveryCoordinator(runStore, tasks, settle, merging, journal, turnQueue, { isMerged });

    await coord.reconcile();

    expect(isMerged).not.toHaveBeenCalled();
    expect(await runStore.get(run.id)).toMatchObject({ state: 'failed', phase: 'terminal' });
    expect(await tasks.get(run.taskId)).toMatchObject({
      state: 'escalated',
      escalationReason: expect.stringContaining('target branch has uncommitted changes; merge via PR/manual'),
    });
    expect(await runStore.countRunning()).toBe(0);
  });

  it('settles a retried merging when its latest result succeeded (issue #270)', async () => {
    const branch = 'nonexistent-branch';
    const baseBranch = 'main';
    const { run, idempotencyKey } = await seedMidMerge(branch, baseBranch);
    await journal.recordResult(run.id, { effect: 'target-ref', idempotencyKey, ok: false, detail: 'target was dirty' });
    await journal.recordIntent(run.id, { effect: 'target-ref', idempotencyKey, expected: { baseBranch, branch } });
    await journal.recordResult(run.id, { effect: 'target-ref', idempotencyKey, ok: true, observed: { baseBranch, branch } });
    const isMerged = vi.fn(async () => false);
    const coord = new CrashRecoveryCoordinator(runStore, tasks, settle, merging, journal, turnQueue, { isMerged });

    await coord.reconcile();

    expect(isMerged).not.toHaveBeenCalled();
    expect(await runStore.get(run.id)).toMatchObject({ state: 'completed', phase: 'terminal' });
  });

  it('yields while reconciling a large merging backlog', async () => {
    for (let i = 0; i < 25; i++) {
      const created = await tasks.create({ prompt: `merging ${i}`, state: 'ready', workingDir: repo });
      await tasks.setState(created.id, 'working');
      const run = await runStore.create(created.id);
      await runStore.update(run.id, { phase: 'merging' });
    }
    let tick = 0;
    let yields = 0;
    const order: string[] = [];

    const done = new CrashRecoveryCoordinator(runStore, tasks, settle, merging, journal, turnQueue, {
      now: () => 1_000_000,
      yieldOptions: {
        budgetMs: 0,
        now: () => tick++,
        yieldNow: async () => {
          yields++;
          await yieldToEventLoop();
        },
      },
    })
      .reconcile()
      .then(() => order.push('done'));
    setImmediate(() => order.push('immediate'));
    await done;
    await yieldToEventLoop();

    expect(yields).toBeGreaterThan(0);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('done'));
    expect((await tasks.list()).every((task) => task.state === 'ready')).toBe(true);
  });
});

