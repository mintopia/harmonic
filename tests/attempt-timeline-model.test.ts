import { describe, expect, it } from 'vitest';
import { continuationLabel, elapsed, feedbackForAttempt, stateTone, taskLabel, verifiedSha } from '../web/src/attempt-timeline-model.js';
import type { Attempt, AttemptTask } from '../web/src/types.js';

const task = (over: Partial<AttemptTask> = {}): AttemptTask => ({
  id: 1, attemptId: 1, type: 'verification', position: 3, state: 'passed', command: 'npm test', verdict: 'pass', verifiedSha: null, logLocator: null, startedAt: 1_000, endedAt: 3_000, ...over,
});
const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 1, taskId: 7, number: 1, state: 'failed', startedAt: 1_000, endedAt: 3_000, feedback: null, tasks: [], ...over,
});

describe('attempt timeline model', () => {
  it('labels ordered task types and their semantic states', () => {
    expect(taskLabel(task())).toBe('Verify · npm test');
    expect(taskLabel(task({ type: 'review', command: null }))).toBe('Review');
    expect(stateTone('running')).toBe('running');
    expect(stateTone('failed')).toBe('failed');
  });

  it('uses the latest verification proof from timeline task rows', () => {
    const old = attempt({ tasks: [task({ verifiedSha: 'old' })] });
    const current = attempt({ id: 2, number: 2, tasks: [task({ id: 2, attemptId: 2, type: 'review', verifiedSha: 'current' })] });
    expect(verifiedSha([old, current])).toBe('current');
    expect(verifiedSha([attempt({ tasks: [task()] })])).toBeNull();
  });

  it('attaches retry feedback to the failed attempt that caused it', () => {
    const failed = attempt();
    const retry = attempt({ id: 2, number: 2, state: 'running', feedback: 'Fix the failing check.' });
    expect(feedbackForAttempt([failed, retry], failed)).toBe('Fix the failing check.');
    expect(feedbackForAttempt([failed, retry], retry)).toBeNull();
    expect(continuationLabel(retry)).toBe('new session, condensed');
    expect(elapsed(1_000, null, 63_000)).toBe('1m 2s');
  });
});
