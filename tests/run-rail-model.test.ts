import { describe, expect, it } from 'vitest';
import {
  continuationNote,
  currentRunId,
  formatRunDuration,
  runDisplay,
  runRailChips,
} from '../web/src/run-rail-model.js';
import type { Cost, Run } from '../web/src/types.js';

const cost = (totalUsd: number | null, byModel: Record<string, number | null> = {}): Cost => ({
  totalUsd,
  byModel,
  incomplete: false,
});

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
    review: null,
    reviewFeedback: null,
    reviewedAt: null,
    reviewDeadline: null,
    startedAt: 1_000_000,
    finishedAt: null,
    ...over,
  };
}

describe('runDisplay', () => {
  it('reads a settled review verdict before the run state', () => {
    // Accepted/rejected win over the phase machine's end — the run is settled.
    expect(runDisplay(run({ review: 'accepted', state: 'completed', phase: 'landing' }))).toEqual({
      word: 'accepted',
      dot: 'accept',
      pulse: false,
    });
    expect(runDisplay(run({ review: 'rejected', state: 'running', phase: 'review' }))).toEqual({
      word: 'rejected',
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

  it('reads a run parked at the human gate as cobalt "awaiting", not amber', () => {
    expect(runDisplay(run({ state: 'running', phase: 'review' }))).toEqual({
      word: 'awaiting',
      dot: 'review',
      pulse: false,
    });
  });

  it('carries the live phase word on a pulsing amber dot for in-flight work', () => {
    expect(runDisplay(run({ state: 'running', phase: 'verifying' }))).toEqual({
      word: 'verifying',
      dot: 'running',
      pulse: true,
    });
    expect(runDisplay(run({ state: 'running', phase: 'landing' }))).toEqual({
      word: 'landing',
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

  it('reads a completed run without a review flag as done', () => {
    expect(runDisplay(run({ state: 'completed', review: null, phase: 'landing' }))).toEqual({
      word: 'completed',
      dot: 'accept',
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

describe('formatRunDuration', () => {
  it('is null while the run is still in flight', () => {
    expect(formatRunDuration(run({ finishedAt: null }))).toBeNull();
  });

  it('shows seconds under a minute and minutes+seconds above', () => {
    expect(formatRunDuration(run({ startedAt: 0, finishedAt: 31_000 }))).toBe('31s');
    expect(formatRunDuration(run({ startedAt: 0, finishedAt: 78_000 }))).toBe('1m 18s');
  });

  it('clamps a negative delta (clock skew) to 0s', () => {
    expect(formatRunDuration(run({ startedAt: 5_000, finishedAt: 4_000 }))).toBe('0s');
  });
});

describe('runRailChips', () => {
  it('yields one chip per run, sorted Run 1 → Run N, flagging the current run', () => {
    const chips = runRailChips([
      run({ id: 30, attempt: 3, state: 'running', phase: 'review', cost: cost(0.71) }),
      run({ id: 10, attempt: 1, state: 'failed', phase: 'validating', cost: cost(0.2), startedAt: 0, finishedAt: 31_000 }),
      run({ id: 20, attempt: 2, review: 'rejected', state: 'running', cost: cost(0.55) }),
    ]);
    expect(chips.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(chips.map((c) => c.label)).toEqual(['Run 1', 'Run 2', 'Run 3']);
    expect(chips.map((c) => c.stateWord)).toEqual(['failed', 'rejected', 'awaiting']);
    expect(chips.map((c) => c.isCurrent)).toEqual([false, false, true]);
    expect(chips[0]!.cost).toBe('$0.20');
    expect(chips[0]!.duration).toBe('31s');
    expect(chips[2]!.dot).toBe('review');
  });

  it('does not mutate the input array order', () => {
    const runs = [run({ id: 2, attempt: 2 }), run({ id: 1, attempt: 1 })];
    runRailChips(runs);
    expect(runs.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe('continuationNote', () => {
  it('names the earlier run whose session the current run resumed', () => {
    const runs = [
      run({ id: 1, attempt: 1, sessionId: 'S-A' }),
      run({ id: 2, attempt: 2, sessionId: 'S-A' }),
      run({ id: 3, attempt: 3, sessionId: 'S-A' }),
    ];
    // Names the most recent earlier run sharing the session (Run 2), not Run 1.
    expect(continuationNote(runs)).toBe('Run 3 continued Run 2’s session');
  });

  it('is null when the current run started its own session', () => {
    const runs = [
      run({ id: 1, attempt: 1, sessionId: 'S-A' }),
      run({ id: 2, attempt: 2, sessionId: 'S-B' }),
    ];
    expect(continuationNote(runs)).toBeNull();
  });

  it('is null with fewer than two runs or no current session id', () => {
    expect(continuationNote([run({ attempt: 1, sessionId: 'S-A' })])).toBeNull();
    expect(continuationNote([])).toBeNull();
    expect(
      continuationNote([run({ id: 1, attempt: 1, sessionId: 'S-A' }), run({ id: 2, attempt: 2, sessionId: null })]),
    ).toBeNull();
  });
});
