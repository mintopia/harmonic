import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { ExecutionChainStore } from '../src/domain/execution-chain-store.js';
import { allWorkspaces } from './helpers.js';

/**
 * The Execution Chain's persisted identity + resolver (issue #129,
 * reliability-design Unit A).
 */
describe('ExecutionChainStore (issue #129)', () => {
  let dir: string;
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runStore: RunStore;
  let chains: ExecutionChainStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-exec-chain-'));
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(asyncDb, () => defaultConfig(), allWorkspaces(asyncDb));
    runStore = new RunStore(asyncDb);
    chains = new ExecutionChainStore(asyncDb);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create() returns distinct ids', async () => {
    const a = await chains.create();
    const b = await chains.create();
    expect(a).not.toBe(b);
  });

  it('resolveForTask mints a fresh chain for a task with no runs', async () => {
    const task = await tasks.create({ prompt: 'fresh line of work', state: 'ready' });
    const chainId = await chains.resolveForTask(task);
    expect(chainId).toBeTypeOf('number');
    // A second, unrelated task with no runs gets its own fresh chain.
    const other = await tasks.create({ prompt: 'another fresh line', state: 'ready' });
    expect(await chains.resolveForTask(other)).not.toBe(chainId);
  });

  it("same-task second attempt inherits the first Run's chain", async () => {
    const task = await tasks.create({ prompt: 'retry me', state: 'ready' });
    const chainId = await chains.resolveForTask(task);
    await runStore.create(task.id, undefined, chainId);

    // A second attempt of the SAME task resolves to the same chain.
    expect(await chains.resolveForTask(task)).toBe(chainId);
  });

  it('a corrective Attempt stays on the original ticket and retains its chain', async () => {
    const ticket = await tasks.create({ prompt: 'original attempt', state: 'ready' });
    const chainId = await chains.resolveForTask(ticket);
    const first = await runStore.create(ticket.id, undefined, chainId);
    const second = await runStore.create(ticket.id, undefined, chainId);

    expect(second.attempt).toBe(first.attempt + 1);
    expect(await chains.resolveForTask(ticket)).toBe(chainId);
  });

  it("listForChain returns member Runs across two different tasks, id-ordered", async () => {
    const taskA = await tasks.create({ prompt: 'chain member A', state: 'ready' });
    const chainId = await chains.resolveForTask(taskA);
    const runA = await runStore.create(taskA.id, undefined, chainId);

    const taskB = await tasks.create({ prompt: 'chain member B', state: 'ready' });
    const runB = await runStore.create(taskB.id, undefined, chainId);

    const members = await chains.listForChain(chainId);
    expect(members.map((r) => r.id)).toEqual([runA.id, runB.id].sort((x, y) => x - y));
    expect(members.every((r) => r.chainId === chainId)).toBe(true);
  });
});
