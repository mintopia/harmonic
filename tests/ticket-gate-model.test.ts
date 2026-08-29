import { describe, expect, it } from 'vitest';
import { gateForRun } from '../web/src/ticket-gate-model.js';
import type { Run, Task } from '../web/src/types.js';

function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    taskId: 7,
    attempt: 1,
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
  run({ id: 10, attempt: 1, state: 'failed' }),
  run({ id: 20, attempt: 2, state: 'failed' }),
  run({ id: 30, attempt: 3, state: 'failed' }), // current: the attempt that escalated
];

describe('gateForRun', () => {
  it('hides the bar when there is no selected run', () => {
    expect(gateForRun({ task: task(), runs: RUNS, selectedRunId: null })).toEqual({ kind: 'none' });
    expect(gateForRun({ task: task(), runs: [], selectedRunId: 99 })).toEqual({ kind: 'none' });
  });

  it('is live on the current run whatever the task state — the state actions belong to the current run only', () => {
    expect(gateForRun({ task: task({ state: 'escalated' }), runs: RUNS, selectedRunId: 30 })).toEqual({ kind: 'live' });
    const working = [run({ id: 30, attempt: 3, state: 'running' })];
    expect(gateForRun({ task: task({ state: 'working' }), runs: working, selectedRunId: 30 })).toEqual({ kind: 'live' });
  });

  it('turns read-only on a historical run even while the task is escalated', () => {
    const gate = gateForRun({ task: task({ state: 'escalated' }), runs: RUNS, selectedRunId: 20 });
    expect(gate).toEqual({
      kind: 'result',
      runId: 20,
      attempt: 2,
      dot: 'fail',
      summary: 'Run 2 failed · superseded by Run 3',
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
