import { describe, expect, it } from 'vitest';
import { taskActions } from '../web/src/task-actions-model.js';
import { TASK_STATES } from '../web/src/types.js';

describe('taskActions', () => {
  // Accept is last so the affirmative holds the terminal position, and cancel
  // is absent by design: it's a disposition inside the Reject dialog, not a
  // peer of the gate's two review verbs.
  it('offers the review gate for awaiting-review, accept last and no cancel', () => {
    expect(taskActions('awaiting-review')).toEqual(['reject', 'accept']);
  });

  it('offers re-attempt for a failed task', () => {
    expect(taskActions('failed')).toEqual(['reattempt', 'cancel']);
  });

  it('offers run/ready plus edit for the editable states', () => {
    expect(taskActions('ready')).toEqual(['run', 'edit', 'cancel']);
    expect(taskActions('draft')).toEqual(['ready', 'edit', 'cancel']);
  });

  it('offers only cancel while a task is running', () => {
    expect(taskActions('running')).toEqual(['cancel']);
  });

  it('lets a blocked task be edited (re-point its model) or cancelled', () => {
    expect(taskActions('blocked')).toEqual(['edit', 'cancel']);
  });

  it('offers no actions for completed (footer hides), and uncancel for cancelled', () => {
    expect(taskActions('completed')).toEqual([]);
    expect(taskActions('cancelled')).toEqual(['uncancel']);
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
