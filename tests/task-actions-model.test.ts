import { describe, expect, it } from 'vitest';
import { showsEscalationRecovery, taskActions } from '../web/src/task-actions-model.js';
import { TASK_STATES } from '../web/src/types.js';

describe('taskActions', () => {
  // Accept is last so the affirmative holds the terminal position, and cancel
  // is absent by design: it's a disposition inside the Reject dialog, not a
  // peer of the gate's two review verbs. Delete (issue #162) sits first,
  // ahead of the gate, rather than disturbing Accept's terminal slot.
  it('offers the review gate for awaiting-review, accept last, delete first, and no cancel', () => {
    expect(taskActions('awaiting-review')).toEqual(['delete', 'reject', 'accept']);
  });

  it('offers delete plus re-attempt for a failed task', () => {
    expect(taskActions('failed')).toEqual(['delete', 'reattempt', 'cancel']);
  });

  it('offers delete plus run/ready and edit for the editable states', () => {
    expect(taskActions('ready')).toEqual(['delete', 'run', 'edit', 'cancel']);
    expect(taskActions('draft')).toEqual(['delete', 'ready', 'edit', 'cancel']);
  });

  // Issue #162: delete is guarded to non-running Tasks, mirroring the
  // server's 409 — running is the one state that never offers it.
  it('offers complete (operator override) and cancel while a task is running, no delete', () => {
    expect(taskActions('running')).toEqual(['complete', 'cancel']);
  });

  it('offers delete for completed (no other action), and delete plus uncancel for cancelled', () => {
    expect(taskActions('completed')).toEqual(['delete']);
    expect(taskActions('cancelled')).toEqual(['delete', 'uncancel']);
  });

  // Delete is the one action offered on every state except running (issue #162).
  it('offers delete on every non-running state', () => {
    for (const state of TASK_STATES) {
      expect(taskActions(state).includes('delete')).toBe(state !== 'running');
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

// issue #191: an escalated Task's stranded-candidate recovery actions
// (Adopt & review, Note to critic) are flag actions layered beside
// taskActions(state) — mirroring Un-escalate — so they get their own pure
// gate rather than living inline in the component.
describe('showsEscalationRecovery', () => {
  it('is false when the task is not escalated, even with a candidate', () => {
    expect(showsEscalationRecovery({ escalated: false, candidateRef: 'refs/harmonic/candidate/run-9137' })).toBe(
      false,
    );
  });

  it('is false when escalated but no run ever produced a candidate', () => {
    expect(showsEscalationRecovery({ escalated: true, candidateRef: null })).toBe(false);
  });

  it('is true only once both an escalation and a stranded candidate are present', () => {
    expect(showsEscalationRecovery({ escalated: true, candidateRef: 'refs/harmonic/candidate/run-9137' })).toBe(
      true,
    );
  });
});
