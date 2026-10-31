import { describe, expect, it } from 'vitest';
import { acceptPresentation, acceptedOutcome, escalationActions, nextUnexecutedStep, taskActions, workflowEscalationNotes } from '../web/src/task-actions-model.js';
import { TASK_STATES } from '../web/src/types.js';

describe('taskActions', () => {
  it('offers the escalation dispositions on escalated, accept last, delete first', () => {
    expect(taskActions('escalated')).toEqual(['delete', 'close', 'retry', 'accept']);
  });

  it('never offers plain cancel or run on escalated — the dispositions are Retry, Close, Accept', () => {
    expect(taskActions('escalated')).not.toContain('cancel');
    expect(taskActions('escalated')).not.toContain('run');
  });

  it('offers delete plus run/ready and edit for the editable states', () => {
    expect(taskActions('ready')).toEqual(['delete', 'run', 'edit', 'cancel']);
    expect(taskActions('draft')).toEqual(['delete', 'ready', 'edit', 'cancel']);
  });

  it('offers pause, extend, complete (operator override), and cancel while a task is working with a wall-clock deadline, no delete', () => {
    expect(taskActions('working', 1_000)).toEqual(['pause', 'extend', 'complete', 'cancel']);
  });

  it('withholds extend while working with no known wall-clock deadline — the server would refuse it (409)', () => {
    expect(taskActions('working')).toEqual(['pause', 'complete', 'cancel']);
    expect(taskActions('working', null)).toEqual(['pause', 'complete', 'cancel']);
  });

  it('offers delete, resume, and cancel while a task is paused', () => {
    expect(taskActions('paused')).toEqual(['delete', 'resume', 'cancel']);
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

  it('offers accept/retry/close only on escalated', () => {
    for (const state of TASK_STATES) {
      const actions = taskActions(state);
      for (const action of ['accept', 'retry', 'close'] as const) {
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
      retry: true,
      close: true,
    });
  });

  it('withholds only Accept when the branch has no candidate', () => {
    expect(escalationActions({ state: 'escalated', hasCandidate: false })).toEqual({ accept: false, retry: true, close: true });
  });
});

describe('Accept disposition', () => {
  it.each([
    ['rebase', 'Accept & implement'],
    ['implementation', 'Accept & verify'],
    ['verification', 'Accept & review'],
    ['review', 'Accept & merge'],
    [null, 'Accept'],
  ] as const)('explains the next action after %s', (step, label) => {
    expect(acceptPresentation(step).label).toBe(label);
  });

  it('reports the response outcome rather than claiming every acceptance merges', () => {
    expect(acceptedOutcome({ state: 'working', mergeStatus: null, currentStep: 'verification' })).toBe('continuing with verification');
    expect(acceptedOutcome({ state: 'working', mergeStatus: null, currentStep: null })).toBe('continuing the pipeline');
    expect(acceptedOutcome({ state: 'done', mergeStatus: null, currentStep: null })).toBe('completed');
    expect(acceptedOutcome({ state: 'escalated', mergeStatus: null, currentStep: null })).toBe('needs your attention');
  });
});

describe('workflowEscalationNotes', () => {
  const outline = [{ id: 'implement', children: [] }, { id: 'security', children: [] }, { id: 'merge', children: [] }];
  const run = (stepId: string, action: string, outcome: 'pass' | 'fail') => ({ stepId, action, outcome, attempt: 1 });

  it('names the failed step, the step Accept continues with and the cleanup count', () => {
    const notes = workflowEscalationNotes({ steps: [run('implement', 'agent', 'pass'), run('security', 'critic', 'fail')], outline, cleanupCount: 1 });
    expect(notes?.heading).toBe('Escalated at step security');
    expect(notes?.accept).toBe('marks step security (critic) as pass and continues with merge. No re-verify; a candidate commit is required. At the last step, Accept continues to Merge.');
    expect(notes?.retry).toBe('starts a new pass of attempts: with the counter reset.');
    expect(notes?.close).toBe('runs the cleanup: list (1 step), then removes the worktree and branch.');
  });

  it('continues to Merge from the last step and finds a failed child through its group', () => {
    expect(workflowEscalationNotes({ steps: [run('merge', 'merge', 'fail')], outline, cleanupCount: 2 })?.accept).toContain('continues to Merge');
    const grouped = [{ id: 'panel', children: ['a', 'b'] }, { id: 'merge', children: [] }];
    expect(workflowEscalationNotes({ steps: [run('b', 'critic', 'fail')], outline: grouped, cleanupCount: 0 })?.accept).toContain('continues with merge');
  });

  it('returns null when nothing is failed', () => {
    expect(workflowEscalationNotes({ steps: [run('a', 'run', 'fail'), run('a', 'run', 'pass')], outline, cleanupCount: 0 })).toBeNull();
  });
});

describe('nextUnexecutedStep', () => {
  it('is the first outline step without a pass or skipped run', () => {
    const outline = [{ id: 'implement', children: [] }, { id: 'verify', children: [] }];
    expect(nextUnexecutedStep({ steps: [{ stepId: 'implement', action: 'agent', outcome: 'pass', attempt: 1 }], outline })).toBe('verify');
    expect(nextUnexecutedStep({ steps: [], outline: [] })).toBeNull();
  });
});
