import { describe, expect, it } from 'vitest';
import { changedFilesFromStat, currentAttemptId, attemptDisplay } from '../web/src/attempt-rail-model.js';
import type { AttemptSummary, Step } from '../web/src/types.js';

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
    startedAt: 1_000_000,
    finishedAt: null,
    ...over,
  };
}

function step(over: Partial<Step> = {}): Step {
  return {
    id: 1,
    attemptId: 1,
    type: 'implementation',
    position: 1,
    state: 'running',
    command: null,
    verdict: null,
    logLocator: null,
    startedAt: 1_000,
    endedAt: null,
    ...over,
  };
}

describe('attemptDisplay', () => {
  it('reads a settled terminal state before whatever Step was running when it ended', () => {
    expect(attemptDisplay(run({ state: 'completed' }), [step({ type: 'review', state: 'passed' })])).toEqual({
      word: 'merged',
      dot: 'merged',
      pulse: false,
    });
    expect(attemptDisplay(run({ state: 'failed' }), [step({ type: 'verification', state: 'failed' })])).toEqual({
      word: 'failed',
      dot: 'fail',
      pulse: false,
    });
  });

  it('colours a failed run fail and a cancelled run neutral, neither pulsing', () => {
    expect(attemptDisplay(run({ state: 'failed' }))).toEqual({
      word: 'failed',
      dot: 'fail',
      pulse: false,
    });
    expect(attemptDisplay(run({ state: 'cancelled' }))).toEqual({
      word: 'cancelled',
      dot: 'neutral',
      pulse: false,
    });
  });

  it('never reads a running run as anything but live work — there is no parked human gate (ADR-0041)', () => {
    for (const type of ['rebase', 'implementation', 'verification', 'review'] as const) {
      const steps = [step({ type, state: 'running' })];
      expect(attemptDisplay(run({ state: 'running' }), steps).pulse).toBe(true);
      expect(attemptDisplay(run({ state: 'running' }), steps).dot).toBe('running');
    }
  });

  it('carries the running Step\'s type as the word on a pulsing amber dot for in-flight work', () => {
    expect(attemptDisplay(run({ state: 'running' }), [step({ type: 'verification', state: 'running' })])).toEqual({
      word: 'verification',
      dot: 'running',
      pulse: true,
    });
    expect(attemptDisplay(run({ state: 'running' }), [step({ type: 'review', state: 'running' })])).toEqual({
      word: 'review',
      dot: 'running',
      pulse: true,
    });
  });

  it('falls back to a generic "running" when no Step is currently running (e.g. mid-merge, or before the first Step starts)', () => {
    expect(attemptDisplay(run({ state: 'running' }), [])).toEqual({
      word: 'running',
      dot: 'running',
      pulse: true,
    });
    // Every Step already settled (passed) — the gap before merge completes.
    expect(attemptDisplay(run({ state: 'running' }), [step({ type: 'implementation', state: 'passed' })]).word).toBe('running');
  });

  it('reads a completed run as merged whatever Step it ended on', () => {
    expect(attemptDisplay(run({ state: 'completed' }), [step({ type: 'review', state: 'passed' })])).toEqual({
      word: 'merged',
      dot: 'merged',
      pulse: false,
    });
  });
});

describe('currentAttemptId', () => {
  it('is the highest attempt, whatever the array order', () => {
    expect(
      currentAttemptId([run({ id: 3, number: 2 }), run({ id: 9, number: 3 }), run({ id: 1, number: 1 })]),
    ).toBe(9);
  });

  it('is null for a task with no runs', () => {
    expect(currentAttemptId([])).toBeNull();
  });
});

describe('changedFilesFromStat', () => {
  it('turns git diff --stat entries into selectable changed-file rows', () => {
    expect(
      changedFilesFromStat(
        ' src/server/rate-limit.ts | 96 ++++++++++++++\n src/server/app.ts        |  8 +---\n 2 files changed, 101 insertions(+), 3 deletions(-)',
      ),
    ).toEqual([
      { path: 'src/server/rate-limit.ts', kind: 'M', additions: 14, deletions: 0 },
      { path: 'src/server/app.ts', kind: 'M', additions: 1, deletions: 3 },
    ]);
  });

  it('does not treat the git summary or an unavailable stat as a file', () => {
    expect(changedFilesFromStat(null)).toEqual([]);
    expect(changedFilesFromStat(' 2 files changed, 101 insertions(+), 3 deletions(-)')).toEqual([]);
  });
});
