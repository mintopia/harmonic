import { describe, expect, it } from 'vitest';
import { gateForAttempt } from '../web/src/ticket-gate-model.js';
import type { AttemptSummary, Task } from '../web/src/types.js';

function run(over: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    id: 1,
    taskId: 7,
    number: 1,
    state: 'running',
    reason: null,
    stopReason: null,
    sessionId: null,
    prompt: null,
    branch: null,
    baseBranch: null,
    usage: null,
    cost: null,
    startedAt: 0,
    finishedAt: null,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return { id: 7, state: 'escalated', ...over } as Task;
}

const RUNS = [
  run({ id: 10, number: 1, state: 'failed' }),
  run({ id: 20, number: 2, state: 'failed' }),
  run({ id: 30, number: 3, state: 'failed' }), // current: the attempt that escalated
];

describe('gateForAttempt', () => {
  it('hides the bar when there is no selected run', () => {
    expect(gateForAttempt({ task: task(), runs: RUNS, selectedAttemptId: null })).toEqual({ kind: 'none' });
    expect(gateForAttempt({ task: task(), runs: [], selectedAttemptId: 99 })).toEqual({ kind: 'none' });
  });

  it('is live on the current run whatever the task state — the state actions belong to the current run only', () => {
    expect(gateForAttempt({ task: task({ state: 'escalated' }), runs: RUNS, selectedAttemptId: 30 })).toEqual({ kind: 'live' });
    const working = [run({ id: 30, number: 3, state: 'running' })];
    expect(gateForAttempt({ task: task({ state: 'working' }), runs: working, selectedAttemptId: 30 })).toEqual({ kind: 'live' });
  });

  it('turns read-only on a historical run even while the task is escalated', () => {
    const gate = gateForAttempt({ task: task({ state: 'escalated' }), runs: RUNS, selectedAttemptId: 20 });
    expect(gate).toEqual({
      kind: 'result',
      attemptId: 20,
      number: 2,
      dot: 'fail',
      summary: 'Attempt 2 failed · superseded by Attempt 3',
      currentAttemptId: 30,
    });
  });

  it('summarises a failed historical run and points at the current run', () => {
    const gate = gateForAttempt({ task: task(), runs: RUNS, selectedAttemptId: 10 });
    expect(gate).toMatchObject({
      kind: 'result',
      number: 1,
      dot: 'fail',
      summary: 'Attempt 1 failed · superseded by Attempt 3',
      currentAttemptId: 30,
    });
  });
});
