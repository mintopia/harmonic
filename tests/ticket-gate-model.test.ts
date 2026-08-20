import { describe, expect, it } from 'vitest';
import { gateForRun } from '../web/src/ticket-gate-model.js';
import type { Run, Task } from '../web/src/types.js';

function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    taskId: 7,
    attempt: 1,
    state: 'running',
    phase: 'review',
    reason: null,
    stopReason: null,
    sessionId: null,
    prompt: null,
    branch: null,
    baseBranch: null,
    usage: null,
    cost: null,
    review: null,
    reviewFeedback: null,
    reviewedAt: null,
    reviewDeadline: null,
    startedAt: 0,
    finishedAt: null,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return { id: 7, state: 'awaiting-review', ...over } as Task;
}

const RUNS = [
  run({ id: 10, attempt: 1, state: 'failed', phase: 'validating' }),
  run({ id: 20, attempt: 2, review: 'rejected', state: 'running', phase: 'review' }),
  run({ id: 30, attempt: 3, state: 'running', phase: 'review' }), // current, at the gate
];

describe('gateForRun', () => {
  it('hides the bar when there is no selected run', () => {
    expect(gateForRun({ task: task(), runs: RUNS, selectedRunId: null })).toEqual({ kind: 'none' });
    expect(gateForRun({ task: task(), runs: [], selectedRunId: 99 })).toEqual({ kind: 'none' });
  });

  it('is the live review gate on the current run when the task is awaiting review', () => {
    expect(gateForRun({ task: task({ state: 'awaiting-review' }), runs: RUNS, selectedRunId: 30 })).toEqual({
      kind: 'live',
      isReviewGate: true,
    });
  });

  it('is live-but-not-a-review-gate on the current run when the task is not awaiting review', () => {
    // A running task's current run shows its state actions, never the gate —
    // the gate can only fire on the real awaiting-review run.
    const running = [run({ id: 30, attempt: 3, state: 'running', phase: 'executing' })];
    expect(gateForRun({ task: task({ state: 'running' }), runs: running, selectedRunId: 30 })).toEqual({
      kind: 'live',
      isReviewGate: false,
    });
  });

  it('turns read-only on a historical run even while the task is awaiting review', () => {
    const gate = gateForRun({ task: task({ state: 'awaiting-review' }), runs: RUNS, selectedRunId: 20 });
    expect(gate).toEqual({
      kind: 'result',
      runId: 20,
      attempt: 2,
      dot: 'fail',
      summary: 'Run 2 rejected · superseded by Run 3',
      currentRunId: 30,
    });
  });

  it('summarises a failed historical run and points at the current run', () => {
    const gate = gateForRun({ task: task(), runs: RUNS, selectedRunId: 10 });
    expect(gate).toMatchObject({
      kind: 'result',
      attempt: 1,
      dot: 'fail',
      summary: 'Run 1 failed · superseded by Run 3',
      currentRunId: 30,
    });
  });
});
