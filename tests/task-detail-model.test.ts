import { describe, expect, it } from 'vitest';
import { contentPanel, taskLifecycle, type LifecycleStepKey, type LifecycleStepStatus } from '../web/src/task-detail-model.js';
import type { AttemptSummary, TaskState } from '../web/src/types.js';

const STEP_ORDER: LifecycleStepKey[] = [
  'worktree',
  'implementation',
  'merge',
  'postMergeCheck',
  'closeIssue',
  'retire',
];

const attempt = (state: AttemptSummary['state']): Pick<AttemptSummary, 'state'> => ({ state });

/** The step statuses keyed by step, so a state's expectation reads as a map. */
function statuses(state: TaskState, attempts: Pick<AttemptSummary, 'state'>[] = []): Record<LifecycleStepKey, LifecycleStepStatus> {
  const { steps } = taskLifecycle(state, attempts);
  return Object.fromEntries(steps.map((s) => [s.key, s.status])) as Record<LifecycleStepKey, LifecycleStepStatus>;
}

describe('contentPanel', () => {
  it('shows Stats when nothing is selected', () => {
    expect(contentPanel({ kind: 'none' })).toEqual({ kind: 'stats', title: 'Stats' });
  });

  it('titles an Attempt by its display number', () => {
    expect(contentPanel({ kind: 'attempt', attemptNumber: 1 })).toEqual({ kind: 'attempt', title: 'Attempt 1' });
    expect(contentPanel({ kind: 'attempt', attemptNumber: 3 })).toEqual({ kind: 'attempt', title: 'Attempt 3' });
  });

  it('titles a changed file by its filename, not its full path', () => {
    expect(contentPanel({ kind: 'file', path: 'web/src/components/TicketPage.tsx' })).toEqual({
      kind: 'diff',
      title: 'TicketPage.tsx',
    });
  });

  it('keeps a root-level file whole as its own title', () => {
    expect(contentPanel({ kind: 'file', path: 'README.md' })).toEqual({ kind: 'diff', title: 'README.md' });
  });

  it('opens the Timeline as its own panel', () => {
    expect(contentPanel({ kind: 'timeline' })).toEqual({ kind: 'timeline', title: 'Timeline' });
  });
});

describe('taskLifecycle', () => {
  it('always returns the six lifecycle steps in order', () => {
    for (const state of ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as TaskState[]) {
      expect(taskLifecycle(state, []).steps.map((s) => s.key)).toEqual(STEP_ORDER);
    }
  });

  it('labels each step for the progress bar', () => {
    expect(taskLifecycle('working', []).steps.map((s) => s.label)).toEqual([
      'Worktree',
      'Implementation',
      'Merge',
      'Post-merge check',
      'Close issue',
      'Retire',
    ]);
  });

  it('has exactly one highlighted node matching `current`, in every state', () => {
    for (const state of ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as TaskState[]) {
      const { steps, current } = taskLifecycle(state, [attempt('running')]);
      const highlighted = steps.filter((s) => s.status === 'current' || s.status === 'failed');
      // `done` settles every node, so it has no lone highlight — it is the one exception.
      if (state === 'done') {
        expect(steps.every((s) => s.status === 'done')).toBe(true);
      } else {
        expect(highlighted).toHaveLength(1);
        expect(highlighted[0]?.key).toBe(current);
      }
    }
  });

  it('points a draft Task at the imminent Worktree node', () => {
    expect(taskLifecycle('draft', []).current).toBe('worktree');
    expect(statuses('draft')).toEqual({
      worktree: 'current',
      implementation: 'pending',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('points a ready Task at the imminent Worktree node', () => {
    expect(statuses('ready')).toEqual({
      worktree: 'current',
      implementation: 'pending',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('sits a working Task on Implementation while an Attempt runs', () => {
    expect(taskLifecycle('working', [attempt('running')]).current).toBe('implementation');
    expect(statuses('working', [attempt('running')])).toEqual({
      worktree: 'done',
      implementation: 'current',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('treats a working Task with only failed Attempts as still on Implementation', () => {
    expect(statuses('working', [attempt('failed'), attempt('running')]).implementation).toBe('current');
  });

  it('advances a working Task to Merge once an Attempt has passed', () => {
    expect(taskLifecycle('working', [attempt('failed'), attempt('completed')]).current).toBe('merge');
    expect(statuses('working', [attempt('completed')])).toEqual({
      worktree: 'done',
      implementation: 'done',
      merge: 'current',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('marks Implementation failed when the Task escalates', () => {
    expect(taskLifecycle('escalated', [attempt('failed')]).current).toBe('implementation');
    expect(statuses('escalated', [attempt('failed')])).toEqual({
      worktree: 'done',
      implementation: 'failed',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('settles every node when the Task is done', () => {
    expect(taskLifecycle('done', [attempt('completed')]).current).toBe('retire');
    expect(statuses('done', [attempt('completed')])).toEqual({
      worktree: 'done',
      implementation: 'done',
      merge: 'done',
      postMergeCheck: 'done',
      closeIssue: 'done',
      retire: 'done',
    });
  });

  it('halts a cancelled Task at Implementation once it has run an Attempt', () => {
    expect(statuses('cancelled', [attempt('cancelled')])).toEqual({
      worktree: 'done',
      implementation: 'failed',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });

  it('halts a cancelled Task at Worktree when it never ran an Attempt', () => {
    expect(taskLifecycle('cancelled', []).current).toBe('worktree');
    expect(statuses('cancelled', [])).toEqual({
      worktree: 'failed',
      implementation: 'pending',
      merge: 'pending',
      postMergeCheck: 'pending',
      closeIssue: 'pending',
      retire: 'pending',
    });
  });
});
