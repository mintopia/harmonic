import { describe, expect, it } from 'vitest';
import { ACTIVE_STATES, TERMINAL_STATES, boardColumns } from '../web/src/board-model.js';
import { TASK_STATES, type Task, type TaskState } from '../web/src/types.js';

const task = (id: number, state: TaskState, createdAt: number): Task => ({
  id,
  prompt: `task ${id}`,
  harness: 'claude',
  model: 'claude-fable-5',
  workingDir: '/tmp',
  isolationMode: 'direct',
  priority: 'normal',
  state,
  createdAt,
  updatedAt: createdAt,
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  cost: null,
});

describe('board column model', () => {
  it('splits every task state into exactly one of active or terminal', () => {
    expect([...ACTIVE_STATES, ...TERMINAL_STATES]).toEqual([...TASK_STATES]);
  });

  it('rails Completed, Failed and Cancelled; the pipeline stays expanded', () => {
    expect(TERMINAL_STATES).toEqual(['completed', 'failed', 'cancelled']);
    expect(ACTIVE_STATES).toEqual(['draft', 'blocked', 'ready', 'running', 'awaiting-review']);
  });

  it('produces one column per state regardless of load (stable geometry)', () => {
    const columns = boardColumns([]);
    expect(columns.map((c) => c.state)).toEqual([...TASK_STATES]);
    for (const column of columns) expect(column.tasks).toEqual([]);
  });

  it('marks terminal columns and buckets tasks newest-first', () => {
    const columns = boardColumns([
      task(1, 'ready', 100),
      task(2, 'ready', 300),
      task(3, 'failed', 200),
    ]);
    const ready = columns.find((c) => c.state === 'ready')!;
    const failed = columns.find((c) => c.state === 'failed')!;
    expect(ready.terminal).toBe(false);
    expect(ready.tasks.map((t) => t.id)).toEqual([2, 1]);
    expect(failed.terminal).toBe(true);
    expect(failed.tasks.map((t) => t.id)).toEqual([3]);
  });
});
