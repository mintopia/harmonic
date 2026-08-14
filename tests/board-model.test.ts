import { describe, expect, it } from 'vitest';
import { ACTIVE_STATES, TERMINAL_STATES, boardColumns, canDrag, dropAction } from '../web/src/board-model.js';
import { TASK_STATES, type Task, type TaskState } from '../web/src/types.js';

const task = (id: number, state: TaskState, createdAt: number, priority: Task['priority'] = 'normal'): Task => ({
  id,
  prompt: `task ${id}`,
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-fable-5',
  workingDir: '/tmp',
  isolationMode: 'direct',
  priority,
  overrides: { harness: null, model: null, isolationMode: null, priority: null },
  state,
  reattemptOf: null,
  feedback: null,
  createdAt,
  updatedAt: createdAt,
  dependsOn: [],
  dependents: [],
  blockedOnFailed: false,
  reattempts: [],
  cost: null,
  origin: 'native',
  trackerRef: null,
  workflow: null,
  wayfinderType: null,
  drive: null,
  escalated: false,
  mapRef: null,
  url: null,
  mapTitle: null,
  branch: null,
  stat: null,
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

  it('marks terminal columns and buckets tasks in processing order (id ascending at equal priority)', () => {
    const columns = boardColumns([
      task(1, 'ready', 100),
      task(2, 'ready', 300),
      task(3, 'failed', 200),
    ]);
    const ready = columns.find((c) => c.state === 'ready')!;
    const failed = columns.find((c) => c.state === 'failed')!;
    expect(ready.terminal).toBe(false);
    expect(ready.tasks.map((t) => t.id)).toEqual([1, 2]);
    expect(failed.terminal).toBe(true);
    expect(failed.tasks.map((t) => t.id)).toEqual([3]);
  });

  it('orders terminal columns newest-first (most recently completed on top), id desc on ties', () => {
    // task()'s createdAt arg doubles as updatedAt; the completion is the last update.
    const columns = boardColumns([
      task(1, 'completed', 100),
      task(2, 'completed', 300),
      task(3, 'completed', 300), // tie with 2 → higher id first
      task(4, 'completed', 200),
    ]);
    const completed = columns.find((c) => c.state === 'completed')!;
    expect(completed.tasks.map((t) => t.id)).toEqual([3, 2, 4, 1]);
  });

  it('orders each column by the scheduler processing order: priority then id ascending', () => {
    // Insertion order is deliberately scrambled and createdAt is irrelevant to the sort.
    const columns = boardColumns([
      task(5, 'ready', 100, 'low'),
      task(2, 'ready', 100, 'high'),
      task(4, 'ready', 100, 'normal'),
      task(1, 'ready', 100, 'high'),
      task(3, 'ready', 100, 'normal'),
    ]);
    const ready = columns.find((c) => c.state === 'ready')!;
    // high (id asc) → normal (id asc) → low
    expect(ready.tasks.map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('drag-and-drop transitions (issue #58)', () => {
  it('maps drops on Ready to the in-place requeue verbs', () => {
    expect(dropAction('draft', 'ready')).toBe('promote');
    expect(dropAction('failed', 'ready')).toBe('requeue');
    expect(dropAction('cancelled', 'ready')).toBe('uncancel');
  });

  it('cancels a card dropped on Cancelled only where DESIGN.md offers cancel', () => {
    // draft/blocked/ready/running — produced nothing to judge, or still producing.
    for (const from of ['draft', 'blocked', 'ready', 'running'] as const) {
      expect(dropAction(from, 'cancelled')).toBe('cancel');
    }
  });

  it('snaps back awaiting-review dropped on Cancelled (cancel is not a gate action)', () => {
    // The API can cancel it; the interface doesn't offer it (DESIGN.md § Buttons).
    expect(dropAction('awaiting-review', 'cancelled')).toBeNull();
  });

  it('snaps back terminal cards dropped on Cancelled', () => {
    for (const from of TERMINAL_STATES) expect(dropAction(from, 'cancelled')).toBeNull();
  });

  it('snaps back drops onto the side-effectful / same columns', () => {
    // running/awaiting-review are button-only gates, ready→ready is a no-op.
    expect(dropAction('ready', 'running')).toBeNull();
    expect(dropAction('awaiting-review', 'completed')).toBeNull();
    expect(dropAction('ready', 'ready')).toBeNull();
    expect(dropAction('running', 'ready')).toBeNull();
  });

  it('makes every card draggable except completed and awaiting-review', () => {
    // awaiting-review is a button-only gate (accept/reject); it has no drag move.
    for (const state of TASK_STATES) {
      expect(canDrag(state)).toBe(state !== 'completed' && state !== 'awaiting-review');
    }
  });
});
