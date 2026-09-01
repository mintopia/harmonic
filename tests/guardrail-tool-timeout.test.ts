import { describe, expect, it } from 'vitest';
import {
  formatToolTimeoutReason,
  toolTimeoutBudgetMs,
  toolTimeoutTrip,
} from '../src/domain/guardrail-tool-timeout.js';

describe('toolTimeoutBudgetMs (issue #131)', () => {
  it('converts minutes to milliseconds', () => {
    expect(toolTimeoutBudgetMs(20)).toBe(1_200_000);
    expect(toolTimeoutBudgetMs(1)).toBe(60_000);
  });
});

describe('toolTimeoutTrip (issue #131)', () => {
  const limitMs = toolTimeoutBudgetMs(20);

  it('does not trip below the limit', () => {
    expect(toolTimeoutTrip({ outstandingMs: limitMs - 1, limitMs })).toBeNull();
  });

  it('trips exactly at the boundary (outstandingMs === limitMs)', () => {
    expect(toolTimeoutTrip({ outstandingMs: limitMs, limitMs })).toEqual({
      dimension: 'tool-timeout',
      limitMs,
      observedMs: limitMs,
      toolCallId: null,
      title: null,
    });
  });

  it('trips above the limit', () => {
    expect(toolTimeoutTrip({ outstandingMs: limitMs + 500_000, limitMs })).toEqual({
      dimension: 'tool-timeout',
      limitMs,
      observedMs: limitMs + 500_000,
      toolCallId: null,
      title: null,
    });
  });

  it('carries toolCallId and title through when supplied', () => {
    expect(
      toolTimeoutTrip({ outstandingMs: limitMs, limitMs, toolCallId: 'tc-1', title: 'Run build' }),
    ).toEqual({
      dimension: 'tool-timeout',
      limitMs,
      observedMs: limitMs,
      toolCallId: 'tc-1',
      title: 'Run build',
    });
  });

  it('defaults toolCallId/title to null when explicitly null', () => {
    expect(
      toolTimeoutTrip({ outstandingMs: limitMs, limitMs, toolCallId: null, title: null }),
    ).toEqual({
      dimension: 'tool-timeout',
      limitMs,
      observedMs: limitMs,
      toolCallId: null,
      title: null,
    });
  });
});

describe('formatToolTimeoutReason (issue #131)', () => {
  it('renders a 20-minute limit as "tool unresponsive: 20m"', () => {
    expect(formatToolTimeoutReason({ limitMs: 20 * 60_000 })).toBe('tool unresponsive: 20m');
  });

  it('renders a sub-minute limit in seconds', () => {
    expect(formatToolTimeoutReason({ limitMs: 45_000 })).toBe('tool unresponsive: 45s');
  });
});
