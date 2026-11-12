import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { baselineConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { AttemptStore } from '../src/domain/attempts.js';
import { WorkflowStepRunStore } from '../src/domain/workflow-step-runs.js';
import { CrashRecoveryCoordinator } from '../src/execution/crash-recovery.js';
import type { SettingsStore } from '../src/server/settings-store.js';
import { allWorkspaces, makeSettingsStore, seedWorkspace } from './helpers.js';
import { yieldToEventLoop } from '../src/reliability/yield.js';
import { trackerRef } from '../src/tracker/adapter.js';
import type { TaskArchive } from '../src/archive/task-archive.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

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

describe('CrashRecoveryCoordinator (ADR-0001)', () => {
  let dir: string;
  let repo: string;
  let asyncDb: AsyncDbHandle;
  let settingsStore: SettingsStore;
  let tasks: TaskService;
  let attempts: AttemptStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-crash-recovery-'));
    repo = makeRepo();
    asyncDb = await openAsyncDb(dir);
    await seedWorkspace(asyncDb);
    settingsStore = await makeSettingsStore(dir);
    tasks = new TaskService(asyncDb, () => baselineConfig(), allWorkspaces(asyncDb, settingsStore));
    attempts = new AttemptStore(asyncDb);
  });

  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('marks a generic (non-worktree) interrupted Run interrupted', async () => {
    const created = await tasks.create({ prompt: 'direct mode', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    await tasks.setState(created.id, 'working');
    const run = await attempts.create(created.id);
    const coord = new CrashRecoveryCoordinator(attempts, tasks, {});

    await coord.reconcile();

    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
  });

  it('closes step runs left running by the crash as inconclusive', async () => {
    const created = await tasks.create({ prompt: 'p', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    await tasks.setState(created.id, 'working');
    const run = await attempts.create(created.id);
    const stepRuns = new WorkflowStepRunStore(asyncDb);
    const base = { taskId: created.id, workflowRef: 'w@1', position: 0, action: 'run', attemptId: run.id };
    const done = await stepRuns.start({ ...base, stepId: 'a' });
    await stepRuns.finish(done.id, { outcome: 'pass', outputs: { stdout: '', exitCode: 0 }, summary: 'ok' });
    await stepRuns.start({ ...base, stepId: 'b' });

    await new CrashRecoveryCoordinator(attempts, tasks, { stepRuns }).reconcile();

    expect((await stepRuns.listForAttempt(run.id)).map((r) => [r.stepId, r.outcome, r.summary])).toEqual([
      ['a', 'pass', 'ok'],
      ['b', 'inconclusive', 'interrupted by process death'],
    ]);
  });

  it('settles an interrupted Epic Attempt and notifies the Epic reconciler so its next poll can retry verification', async () => {
    const workspaces = new WorkspaceService(asyncDb, settingsStore);
    const workspace = await workspaces.create({ name: 'Epic recovery', workingDir: repo });
    await tasks.syncEpics(workspace.id, [{ ref: trackerRef(42), kind: 'epic' }]);
    const attempt = await attempts.createForEpic({ workspaceId: workspace.id, epicRef: trackerRef(42) });
    const onEpicAttemptInterrupted = vi.fn();
    const coord = new CrashRecoveryCoordinator(attempts, tasks, {
      onEpicAttemptInterrupted,
    });

    await coord.reconcile();

    expect(await attempts.get(attempt.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
    expect(onEpicAttemptInterrupted).toHaveBeenCalledWith(expect.objectContaining({ id: attempt.id, workspaceId: workspace.id, epicRef: '42' }));
  });

  it('leaves a paused Task paused while marking its interrupted Run failed', async () => {
    const created = await tasks.create({ prompt: 'pause me', state: 'ready', workingDir: repo, isolationMode: 'direct' });
    await tasks.setState(created.id, 'working');
    await tasks.setState(created.id, 'paused');
    const run = await attempts.create(created.id);
    const coord = new CrashRecoveryCoordinator(attempts, tasks, {});

    await coord.reconcile();

    expect(await attempts.get(run.id)).toMatchObject({ state: 'failed', reason: 'process-death' });
    expect((await tasks.get(created.id)).state).toBe('paused');
  });

  it('yields while reconciling a large backlog of running orphans', async () => {
    for (let i = 0; i < 25; i++) {
      const created = await tasks.create({ prompt: `orphan ${i}`, state: 'ready', workingDir: repo, isolationMode: 'worktree' });
      await tasks.setState(created.id, 'working');
      await attempts.update((await attempts.create(created.id)).id, { branch: 'main', baseBranch: 'main' });
    }
    let tick = 0;
    let yields = 0;
    const order: string[] = [];
    const coord = new CrashRecoveryCoordinator(attempts, tasks, {
      archive: { copyNative: async () => undefined } as unknown as TaskArchive,
      yieldOptions: {
        budgetMs: 0,
        now: () => tick++,
        yieldNow: async () => {
          yields++;
          await yieldToEventLoop();
        },
      },
    });

    const done = coord.reconcile().then(() => order.push('done'));
    setImmediate(() => order.push('immediate'));
    await done;
    await yieldToEventLoop();

    expect(yields).toBeGreaterThan(0);
    expect(order.indexOf('immediate')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('immediate')).toBeLessThan(order.indexOf('done'));
    expect((await attempts.listAllRunning())).toHaveLength(0);
  });
});
