import { describe, expect, it } from 'vitest';
import { activeExecutionDurationMs, durationPercentiles, percentile } from '../src/domain/attempt-duration.js';

describe('activeExecutionDurationMs', () => {
  it('uses the sum of agent turns, excluding pause, verification, and merging', () => {
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: 9000, agentDurationMs: 3000 })).toBe(3000);
  });

  it('falls back to finished − started for historical rows without timing facts', () => {
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: 5000, agentDurationMs: null })).toBe(4000);
  });

  it('is null when a historical row has no finish time', () => {
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: null, agentDurationMs: null })).toBeNull();
    expect(activeExecutionDurationMs({ startedAt: 1000, finishedAt: null, agentDurationMs: 200 })).toBeNull();
  });

  it('is null (never negative) when a timestamp is out of order', () => {
    expect(activeExecutionDurationMs({ startedAt: 5000, finishedAt: 1000, agentDurationMs: null })).toBeNull();
  });

  it('keeps a measured zero instead of using wall time', () => {
    expect(activeExecutionDurationMs({ startedAt: 0, finishedAt: 100, agentDurationMs: 0 })).toBe(0);
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
