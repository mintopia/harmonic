import { describe, expect, it } from 'vitest';
import { changedFilesFromStat, currentRunId, runDisplay } from '../web/src/run-rail-model.js';
import type { Run } from '../web/src/types.js';

function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    taskId: 7,
    attempt: 1,
    state: 'running',
    phase: 'executing',
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

describe('runDisplay', () => {
  it('reads a settled terminal state before the phase the machine ended in', () => {
    expect(runDisplay(run({ state: 'completed', phase: 'landing' }))).toEqual({
      word: 'merged',
      dot: 'merged',
      pulse: false,
    });
    expect(runDisplay(run({ state: 'failed', phase: 'verifying' }))).toEqual({
      word: 'failed',
      dot: 'fail',
      pulse: false,
    });
  });

  it('colours a failed run fail and a cancelled run neutral, neither pulsing', () => {
    expect(runDisplay(run({ state: 'failed', phase: 'validating' }))).toEqual({
      word: 'failed',
      dot: 'fail',
      pulse: false,
    });
    expect(runDisplay(run({ state: 'cancelled', phase: null }))).toEqual({
      word: 'cancelled',
      dot: 'neutral',
      pulse: false,
    });
  });

  it('never reads a running run as anything but live work — there is no parked human gate (ADR-0041)', () => {
    for (const phase of ['executing', 'validating', 'verifying', 'landing'] as const) {
      expect(runDisplay(run({ state: 'running', phase })).pulse).toBe(true);
      expect(runDisplay(run({ state: 'running', phase })).dot).toBe('running');
    }
  });

  it('carries the live phase word on a pulsing amber dot for in-flight work', () => {
    expect(runDisplay(run({ state: 'running', phase: 'verifying' }))).toEqual({
      word: 'verifying',
      dot: 'running',
      pulse: true,
    });
    expect(runDisplay(run({ state: 'running', phase: 'landing' }))).toEqual({
      word: 'merging',
      dot: 'running',
      pulse: true,
    });
  });

  it('falls back to a generic "running" for a pre-feature run with no phase', () => {
    expect(runDisplay(run({ state: 'running', phase: null }))).toEqual({
      word: 'running',
      dot: 'running',
      pulse: true,
    });
    // 'terminal' is an internal end-marker, not a word to show.
    expect(runDisplay(run({ state: 'running', phase: 'terminal' })).word).toBe('running');
  });

  it('reads a completed run as merged whatever phase it ended in', () => {
    expect(runDisplay(run({ state: 'completed', phase: 'terminal' }))).toEqual({
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
