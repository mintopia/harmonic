import { describe, expect, it } from 'vitest';
import { activeExecutionDurationMs, durationPercentiles, percentile } from '../src/domain/attempt-duration.js';

describe('activeExecutionDurationMs', () => {
  it('measures agent-finish ts minus run start, excluding review-park + merging wait', () => {
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: 9000, agentFinishTs: 4000 })).toBe(3000);
  });

  it('falls back to finished − started when there is no agent-finish fact', () => {
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: 5000, agentFinishTs: null })).toBe(4000);
  });

  it('is null when the run has neither an agent-finish fact nor a finish time', () => {
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: null, agentFinishTs: null })).toBeNull();
  });

  it('is null (never negative) when a timestamp is out of order', () => {
    expect(activeExecutionDurationMs({ startedAt: 5000, finishedAt: 9000, agentFinishTs: 1000 })).toBeNull();
    expect(activeExecutionDurationMs({ startedAt: 5000, finishedAt: 1000, agentFinishTs: null })).toBeNull();
  });

  it('prefers the agent-finish fact even when a finish time is also present', () => {
    expect(activeExecutionDurationMs({ startedAt: 0, finishedAt: 100, agentFinishTs: 40 })).toBe(40);
  });
});

describe('percentile', () => {
  it('returns the median (p50) with linear interpolation on an even-length set', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });

  it('returns the middle value on an odd-length set', () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
  });

  it('interpolates the p95', () => {
    expect(percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBeCloseTo(95, 10);
  });

  it('ignores input order', () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(25);
  });

  it('returns the sole value for a single-element set', () => {
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('durationPercentiles', () => {
  it('is null for an empty set (no honest headline to show)', () => {
    expect(durationPercentiles([])).toBeNull();
  });

  it('reports p50 and p95 across the set', () => {
    expect(durationPercentiles([10, 20, 30, 40])).toEqual({ p50: 25, p95: 38.5 });
  });
});
