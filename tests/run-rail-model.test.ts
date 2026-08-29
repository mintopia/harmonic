import { describe, expect, it } from 'vitest';
import { changedFilesFromStat, currentRunId, runDisplay } from '../web/src/run-rail-model.js';
import type { Run, Step } from '../web/src/types.js';

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

describe('runDisplay', () => {
  it('reads a settled terminal state before whatever Step was running when it ended', () => {
    expect(runDisplay(run({ state: 'completed' }), [step({ type: 'review', state: 'passed' })])).toEqual({
      word: 'merged',
      dot: 'merged',
      pulse: false,
    });
    expect(runDisplay(run({ state: 'failed' }), [step({ type: 'verification', state: 'failed' })])).toEqual({
      word: 'failed',
      dot: 'fail',
      pulse: false,
    });
  });

  it('colours a failed run fail and a cancelled run neutral, neither pulsing', () => {
    expect(runDisplay(run({ state: 'failed' }))).toEqual({
      word: 'failed',
      dot: 'fail',
      pulse: false,
    });
    expect(runDisplay(run({ state: 'cancelled' }))).toEqual({
      word: 'cancelled',
      dot: 'neutral',
      pulse: false,
    });
  });

  it('never reads a running run as anything but live work — there is no parked human gate (ADR-0041)', () => {
    for (const type of ['rebase', 'implementation', 'verification', 'review'] as const) {
      const steps = [step({ type, state: 'running' })];
      expect(runDisplay(run({ state: 'running' }), steps).pulse).toBe(true);
      expect(runDisplay(run({ state: 'running' }), steps).dot).toBe('running');
    }
  });

  it('carries the running Step\'s type as the word on a pulsing amber dot for in-flight work', () => {
    expect(runDisplay(run({ state: 'running' }), [step({ type: 'verification', state: 'running' })])).toEqual({
      word: 'verification',
      dot: 'running',
      pulse: true,
    });
    expect(runDisplay(run({ state: 'running' }), [step({ type: 'review', state: 'running' })])).toEqual({
      word: 'review',
      dot: 'running',
      pulse: true,
    });
  });

  it('falls back to a generic "running" when no Step is currently running (e.g. mid-merge, or before the first Step starts)', () => {
    expect(runDisplay(run({ state: 'running' }), [])).toEqual({
      word: 'running',
      dot: 'running',
      pulse: true,
    });
    // Every Step already settled (passed) — the gap before merge completes.
    expect(runDisplay(run({ state: 'running' }), [step({ type: 'implementation', state: 'passed' })]).word).toBe('running');
  });

  it('reads a completed run as merged whatever Step it ended on', () => {
    expect(runDisplay(run({ state: 'completed' }), [step({ type: 'review', state: 'passed' })])).toEqual({
      word: 'merged',
      dot: 'merged',
      pulse: false,
    });
  });
});

describe('currentRunId', () => {
  it('is the highest attempt, whatever the array order', () => {
    expect(
      currentRunId([run({ id: 3, attempt: 2 }), run({ id: 9, attempt: 3 }), run({ id: 1, attempt: 1 })]),
    ).toBe(9);
  });

  it('is null for a task with no runs', () => {
    expect(currentRunId([])).toBeNull();
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
