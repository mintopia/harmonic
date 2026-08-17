import { describe, expect, it } from 'vitest';
import {
  EXECUTION_BUDGET_PHASES,
  countsTowardExecutionBudget,
  formatBudgetReason,
  wallClockBudgetMs,
  wallClockTrip,
} from '../src/domain/guardrail-budget.js';
import { RUN_PHASES, type RunPhase } from '../src/domain/run-phases.js';

describe('EXECUTION_BUDGET_PHASES (issue #127)', () => {
  it('is exactly executing/validating/verifying', () => {
    expect(new Set(EXECUTION_BUDGET_PHASES)).toEqual(new Set(['executing', 'validating', 'verifying']));
  });
});

describe('countsTowardExecutionBudget (issue #127)', () => {
  const expected: Record<RunPhase, boolean> = {
    executing: true,
    validating: true,
    verifying: true,
    review: false,
    landing: false,
    terminal: false,
  };

  // Iterate RUN_PHASES so a new phase added to the machine forces a
  // conscious choice here rather than silently defaulting.
  for (const phase of RUN_PHASES) {
    it(`${phase} -> ${expected[phase]}`, () => {
      expect(countsTowardExecutionBudget(phase)).toBe(expected[phase]);
    });
  }

  it('null (pre-phase) counts as executing', () => {
    expect(countsTowardExecutionBudget(null)).toBe(true);
  });
});

describe('wallClockBudgetMs', () => {
  it('converts minutes to milliseconds', () => {
    expect(wallClockBudgetMs({ wallClockMinutes: 45 })).toBe(2_700_000);
    expect(wallClockBudgetMs({ wallClockMinutes: 1 })).toBe(60_000);
  });
});

describe('wallClockTrip (issue #127, the phase-scoping decision)', () => {
  const budget = { wallClockMinutes: 45 }; // 2_700_000ms

  it('trips when elapsed >= budget in an execution phase', () => {
    for (const phase of ['executing', 'validating', 'verifying'] as const) {
      expect(wallClockTrip({ elapsedMs: 3_000_000, phase, budget })).toEqual({
        dimension: 'wall-clock',
        limitMs: 2_700_000,
        observedMs: 3_000_000,
      });
    }
  });

  it('does NOT trip when elapsed >= budget but the phase is review (core acceptance)', () => {
    expect(wallClockTrip({ elapsedMs: 100_000_000, phase: 'review', budget })).toBeNull();
  });

  it('does NOT trip when elapsed >= budget but the phase is landing (core acceptance)', () => {
    expect(wallClockTrip({ elapsedMs: 100_000_000, phase: 'landing', budget })).toBeNull();
  });

  it('does NOT trip when the phase is terminal, even massively over budget', () => {
    expect(wallClockTrip({ elapsedMs: 100_000_000, phase: 'terminal', budget })).toBeNull();
  });

  it('does not trip below budget in an execution phase', () => {
    expect(wallClockTrip({ elapsedMs: 2_699_999, phase: 'executing', budget })).toBeNull();
  });

  it('trips exactly at the boundary (elapsedMs === limitMs)', () => {
    expect(wallClockTrip({ elapsedMs: 2_700_000, phase: 'verifying', budget })).toEqual({
      dimension: 'wall-clock',
      limitMs: 2_700_000,
      observedMs: 2_700_000,
    });
  });

  it('null phase (pre-phase) trips like an execution phase', () => {
    expect(wallClockTrip({ elapsedMs: 2_700_000, phase: null, budget })).toEqual({
      dimension: 'wall-clock',
      limitMs: 2_700_000,
      observedMs: 2_700_000,
    });
  });

  it('trip payload carries the correct limitMs/observedMs for a different budget', () => {
    const smallBudget = { wallClockMinutes: 5 }; // 300_000ms
    expect(wallClockTrip({ elapsedMs: 450_000, phase: 'executing', budget: smallBudget })).toEqual({
      dimension: 'wall-clock',
      limitMs: 300_000,
      observedMs: 450_000,
    });
  });
});

describe('formatBudgetReason (issue #127, ADR-0019)', () => {
  it('renders a 45-minute budget as "budget: 45m"', () => {
    expect(formatBudgetReason({ dimension: 'wall-clock', limitMs: 2_700_000 })).toBe('budget: 45m');
  });

  it('renders a 1-minute budget as "budget: 1m"', () => {
    expect(formatBudgetReason({ dimension: 'wall-clock', limitMs: 60_000 })).toBe('budget: 1m');
  });

  it('renders a sub-minute duration in seconds', () => {
    expect(formatBudgetReason({ dimension: 'wall-clock', limitMs: 45_000 })).toBe('budget: 45s');
  });

  it('renders exactly 1 second as "budget: 1s"', () => {
    expect(formatBudgetReason({ dimension: 'wall-clock', limitMs: 1_000 })).toBe('budget: 1s');
  });

  it('renders a sub-second duration in raw milliseconds', () => {
    expect(formatBudgetReason({ dimension: 'wall-clock', limitMs: 500 })).toBe('budget: 500ms');
  });
});
