import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
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
  let db: Db;
  // RunStore migrated to the async libsql Db (ADR-0029 #203); this fixture
  // runs both connections on the one file.
  let asyncDb: AsyncDbHandle;
  let tasks: TaskService;
  let runStore: RunStore;
  let chains: ExecutionChainStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-exec-chain-'));
    db = openDb(dir);
    asyncDb = await openAsyncDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runStore = new RunStore(asyncDb);
    chains = new ExecutionChainStore(db);
  });
  afterEach(async () => {
    await asyncDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create() returns distinct ids', () => {
    const a = chains.create();
    const b = chains.create();
    expect(a).not.toBe(b);
  });

  it('resolveForTask mints a fresh chain for a task with no runs', () => {
    const task = tasks.create({ prompt: 'fresh line of work', state: 'ready' });
    const chainId = chains.resolveForTask(task);
    expect(chainId).toBeTypeOf('number');
    // A second, unrelated task with no runs gets its own fresh chain.
    const other = tasks.create({ prompt: 'another fresh line', state: 'ready' });
    expect(chains.resolveForTask(other)).not.toBe(chainId);
  });

  it("same-task second attempt inherits the first Run's chain", async () => {
    const task = tasks.create({ prompt: 'retry me', state: 'ready' });
    const chainId = chains.resolveForTask(task);
    await runStore.create(task.id, undefined, chainId);

    // A second attempt of the SAME task resolves to the same chain.
    expect(chains.resolveForTask(task)).toBe(chainId);
  });

  it('reattempt: a new linked Task inherits the original Task chain', async () => {
    const original = tasks.create({ prompt: 'original attempt', state: 'ready' });
    const chainId = chains.resolveForTask(original);
    await runStore.create(original.id, undefined, chainId);
    tasks.setState(original.id, 'failed'); // reattempt requires a finished task

    const reattempt = tasks.reattempt(original.id, 'try again');
    expect(chains.resolveForTask(reattempt)).toBe(chainId);
  });

  it("listForChain returns member Runs across two different tasks, id-ordered", async () => {
    const taskA = tasks.create({ prompt: 'chain member A', state: 'ready' });
    const chainId = chains.resolveForTask(taskA);
    const runA = await runStore.create(taskA.id, undefined, chainId);

    const taskB = tasks.create({ prompt: 'chain member B', state: 'ready' });
    const runB = await runStore.create(taskB.id, undefined, chainId);

    const members = chains.listForChain(chainId);
    expect(members.map((r) => r.id)).toEqual([runA.id, runB.id].sort((x, y) => x - y));
    expect(members.every((r) => r.chainId === chainId)).toBe(true);
  });
});
