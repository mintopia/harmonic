import { describe, expect, it } from 'vitest';
import { Runner } from '../src/execution/runner.js';
import { ActiveRuns, type ActiveRun } from '../src/execution/active-runs.js';

describe('steer log events', () => {
  it('carry the running step run id', () => {
    const activeRuns = new ActiveRuns();
    const live: { stepRunId?: number }[] = [];
    const runner = Object.assign(Object.create(Runner.prototype) as object, {
      activeRuns,
      events: { onAttemptLogEvent: (e: { stepRunId?: number }) => live.push(e) },
    });
    const emit = (runner as unknown as { emitSteerLog(a: { attemptId: number; text: string; queued: boolean }): void }).emitSteerLog.bind(runner);
    emit({ attemptId: 1, text: 'no step', queued: true });
    activeRuns.set(1, { attemptId: 1, taskId: 1, stepRunId: 9 } as ActiveRun);
    emit({ attemptId: 1, text: 'during step', queued: false });
    expect(live[0]?.stepRunId).toBeUndefined();
    expect(live[1]?.stepRunId).toBe(9);
  });
});
