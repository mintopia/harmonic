import { describe, expect, it } from 'vitest';
import { taskActions } from '../web/src/task-actions-model.js';
import { TASK_STATES } from '../web/src/types.js';

describe('taskActions', () => {
  it('offers the review gate for awaiting-review', () => {
    expect(taskActions('awaiting-review')).toEqual(['accept', 'reject', 'cancel']);
  });

  it('offers re-attempt for a failed task', () => {
    expect(taskActions('failed')).toEqual(['reattempt', 'cancel']);
  });

  it('offers run/ready plus edit for the editable states', () => {
    expect(taskActions('ready')).toEqual(['run', 'edit', 'cancel']);
    expect(taskActions('draft')).toEqual(['ready', 'edit', 'cancel']);
  });

  it('offers only cancel while a task is in flight', () => {
    expect(taskActions('running')).toEqual(['cancel']);
    expect(taskActions('blocked')).toEqual(['cancel']);
  });

  it('offers no actions for terminal states (footer hides)', () => {
    expect(taskActions('completed')).toEqual([]);
    expect(taskActions('cancelled')).toEqual([]);
  });

  it('covers every task state (no state falls through to undefined)', () => {
    for (const state of TASK_STATES) {
      expect(Array.isArray(taskActions(state))).toBe(true);
    }
  });

  it('returns [] for an unknown state instead of crashing (server version skew)', () => {
    expect(taskActions('some-future-state' as never)).toEqual([]);
  });
});
