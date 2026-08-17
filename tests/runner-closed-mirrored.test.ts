import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { defaultConfig } from '../src/config.js';
import { TaskService } from '../src/domain/tasks.js';
import { RunStore } from '../src/domain/runs.js';
import { WorkContextLeaseStore } from '../src/domain/work-context-leases.js';
import { Runner } from '../src/execution/runner.js';
import { allWorkspaces } from './helpers.js';

// The board-refresh backstop with *no agent attached* (issue: a mirrored Task
// left `running` on the board while its ticket has closed, but nothing is
// driving it). completeClosedMirrored must still settle it done — the agent-less
// counterpart of the parked-agent path, which is exercised via a live harness.
describe('Runner.completeClosedMirrored — no agent working the Task', () => {
  let dir: string;
  let db: Db;
  let tasks: TaskService;
  let runs: RunStore;
  let runner: Runner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-ccm-'));
    db = openDb(dir);
    tasks = new TaskService(db, () => defaultConfig(), allWorkspaces(db));
    runs = new RunStore(db);
    runner = new Runner(runs, tasks, new WorkContextLeaseStore(db), db, () => defaultConfig());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('settles a still-running Task with no Run in flight', () => {
    const task = tasks.create({ prompt: 'stuck', state: 'ready' });
    tasks.setState(task.id, 'running'); // flipped running, but nothing is driving it

    expect(runner.completeClosedMirrored(task.id)).toBe(true);
    expect(tasks.get(task.id).state).toBe('completed');
  });

  it('unblocks dependents when it settles, like any completion', () => {
    const blocker = tasks.create({ prompt: 'blocker', state: 'ready' });
    const dependent = tasks.create({ prompt: 'dependent', state: 'ready' });
    tasks.addDependency(dependent.id, blocker.id);
    expect(tasks.get(dependent.id).state).toBe('blocked');
    tasks.setState(blocker.id, 'running');

    runner.completeClosedMirrored(blocker.id);
    expect(tasks.get(dependent.id).state).toBe('ready');
  });

  it('leaves a Task with a live Run row alone (a Run is mid-spawn)', () => {
    const task = tasks.create({ prompt: 'launching', state: 'ready' });
    tasks.setState(task.id, 'running');
    runs.create(task.id); // Run row exists (state running); its ActiveRun not yet registered

    expect(runner.completeClosedMirrored(task.id)).toBe(false);
    expect(tasks.get(task.id).state).toBe('running');
  });

  it('settles once the in-flight Run row has finished without settling the Task', () => {
    const task = tasks.create({ prompt: 'orphaned', state: 'ready' });
    tasks.setState(task.id, 'running');
    const run = runs.create(task.id);
    runs.finish(run.id, 'failed'); // Run ended but the Task was left running

    expect(runner.completeClosedMirrored(task.id)).toBe(true);
    expect(tasks.get(task.id).state).toBe('completed');
  });

  it('is a no-op on a Task that is no longer running', () => {
    const task = tasks.create({ prompt: 'done', state: 'ready' });
    tasks.setState(task.id, 'running');
    tasks.setState(task.id, 'completed'); // a racing settle won

    expect(runner.completeClosedMirrored(task.id)).toBe(false);
    expect(tasks.get(task.id).state).toBe('completed');
  });
});
