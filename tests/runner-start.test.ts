import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore, type RunGuardrailSnapshot } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { ExecutionChainStore } from '../src/domain/execution-chain-store.js';
import { Runner } from '../src/execution/runner.js';
import { allWorkspaces } from './helpers.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Runner.start (issue #272)', () => {
  let dir: string;
  let repoDir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runs: RunStore;
  let chains: ExecutionChainStore;
  let runner: Runner;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-runner-start-'));
    repoDir = join(dir, 'repo');
    mkdirSync(repoDir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runs = new RunStore(asyncDb);
    chains = new ExecutionChainStore(asyncDb);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(asyncDb), asyncDb, () => defaultConfig());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runner.shutdown();
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims the ready worktree task before launch, so concurrent manual starts create exactly one active run', async () => {
    const task = await tasks.create({
      prompt: 'start me once',
      isolationMode: 'worktree',
      workingDir: repoDir,
    });

    const release = deferred();
    const beginRun = vi
      .spyOn(runner as unknown as { beginRun: (taskArg: { id: number }) => Promise<unknown> }, 'beginRun')
      .mockImplementation(async (taskArg) => {
        await release.promise;
        const snapshot: RunGuardrailSnapshot = {
          guardrailConfig: defaultConfig().guardrails,
          priceTable: defaultConfig().prices,
        };
        const chainId = await chains.resolveForTask(await tasks.get(taskArg.id));
        return await runs.create(taskArg.id, snapshot, chainId);
      });

    const started = Promise.allSettled([runner.start(task.id), runner.start(task.id)]);
    await vi.waitFor(() => expect(beginRun).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    release.resolve();

    const results = await started;
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(beginRun).toHaveBeenCalledTimes(1);
    expect((await runs.listForTask(task.id)).map((run) => run.state)).toEqual(['running']);
    expect((await tasks.get(task.id)).state).toBe('running');
  });

  it('returns the task to ready when launch fails after the claim', async () => {
    const task = await tasks.create({
      prompt: 'put me back',
      isolationMode: 'worktree',
      workingDir: repoDir,
    });

    vi.spyOn(runner as unknown as { beginRun: () => Promise<never> }, 'beginRun').mockRejectedValue(new Error('launch failed'));

    await expect(runner.start(task.id)).rejects.toThrow('launch failed');
    expect((await tasks.get(task.id)).state).toBe('ready');
    expect(await runs.listForTask(task.id)).toEqual([]);
  });
});
