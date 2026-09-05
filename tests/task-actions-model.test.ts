import { describe, expect, it } from 'vitest';
import { escalationActions, taskActions } from '../web/src/task-actions-model.js';
import { TASK_STATES } from '../web/src/types.js';

describe('taskActions', () => {
  it('offers exactly the three escalation actions on escalated, accept last, delete first', () => {
    expect(taskActions('escalated')).toEqual(['delete', 'close', 'reject', 'accept']);
  });

  it('never offers plain cancel or requeue on escalated — Close and Reject with guidance are the dispositions', () => {
    expect(taskActions('escalated')).not.toContain('cancel');
    expect(taskActions('escalated')).not.toContain('run');
  });

  it('offers delete plus run/ready and edit for the editable states', () => {
    expect(taskActions('ready')).toEqual(['delete', 'run', 'edit', 'cancel']);
    expect(taskActions('draft')).toEqual(['delete', 'ready', 'edit', 'cancel']);
  });

  it('offers complete (operator override) and cancel while a task is working, no delete', () => {
    expect(taskActions('working')).toEqual(['complete', 'cancel']);
  });

  it('offers delete and cancel while a task is paused', () => {
    expect(taskActions('paused')).toEqual(['delete', 'cancel']);
  });

  it('offers delete for done (no other action), and delete plus uncancel for cancelled', () => {
    expect(taskActions('done')).toEqual(['delete']);
    expect(taskActions('cancelled')).toEqual(['delete', 'uncancel']);
  });

  it('offers delete on every non-working state', () => {
    for (const state of TASK_STATES) {
      expect(taskActions(state).includes('delete')).toBe(state !== 'working');
    }
  });

  it('offers accept/reject/close only on escalated', () => {
    for (const state of TASK_STATES) {
      const actions = taskActions(state);
      for (const action of ['accept', 'reject', 'close'] as const) {
        expect(actions.includes(action)).toBe(state === 'escalated');
      }
    }
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

describe('escalationActions', () => {
  it('is null off the escalation surface, even with a candidate', () => {
    expect(escalationActions({ state: 'ready', hasCandidate: true })).toBeNull();
    expect(escalationActions({ state: 'working', hasCandidate: true })).toBeNull();
  });

  it('offers all three when the escalated ticket has a candidate', () => {
    expect(escalationActions({ state: 'escalated', hasCandidate: true })).toEqual({
      accept: true,
      reject: true,
      close: true,
    });
  });

  it('withholds only Accept when the branch has no candidate', () => {
    expect(escalationActions({ state: 'escalated', hasCandidate: false })).toEqual({ accept: false, reject: true, close: true });
  });
});
