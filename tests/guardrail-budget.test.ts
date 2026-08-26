import { describe, expect, it } from 'vitest';
import {
  EXECUTION_BUDGET_PHASES,
  countsTowardExecutionBudget,
  formatBudgetReason,
  formatUnmeasurableReason,
  spendTrip,
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

  it('does NOT trip when elapsed >= budget but the phase is terminal (core acceptance)', () => {
    expect(wallClockTrip({ elapsedMs: 100_000_000, phase: 'terminal', budget })).toBeNull();
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

  it('renders a token budget in millions', () => {
    expect(formatBudgetReason({ dimension: 'tokens', limitTokens: 2_000_000 })).toBe('budget: 2M tokens');
  });

  it('renders a small token budget as a raw count', () => {
    expect(formatBudgetReason({ dimension: 'tokens', limitTokens: 500 })).toBe('budget: 500 tokens');
  });

  it('renders a cost budget as whole dollars', () => {
    expect(formatBudgetReason({ dimension: 'cost', limitUsd: 10 })).toBe('budget: $10');
  });

  it('renders a cost budget with cents', () => {
    expect(formatBudgetReason({ dimension: 'cost', limitUsd: 10.5 })).toBe('budget: $10.5');
  });
});

describe('formatUnmeasurableReason (issue #128)', () => {
  it('renders the tokens dimension', () => {
    expect(formatUnmeasurableReason('tokens')).toBe('budget: tokens unmeasurable');
  });

  it('renders the cost dimension', () => {
    expect(formatUnmeasurableReason('cost')).toBe('budget: cost unmeasurable');
  });
});

describe('spendTrip (issue #128, the token/cost spend decision)', () => {
  const executionPhases = ['executing', 'validating', 'verifying'] as const;
  const nonExecutionPhases = ['landing', 'terminal'] as const;

  describe('token cap only', () => {
    const budget = { tokens: 1_000, costUsd: null };

    it('trips exactly at the boundary (observedTokens === limit)', () => {
      for (const phase of executionPhases) {
        expect(
          spendTrip({ phase, budget, observedTokens: 1_000, observedUsd: null, costIncomplete: false }),
        ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_000 } });
      }
    });

    it('trips over the boundary', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: 1_500, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } });
    });

    it('does not trip below the boundary', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: 999, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'ok' });
    });

    it('is unmeasurable when observedTokens is null', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: null, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'tokens' });
    });

    it('null phase (pre-phase) is governed like an execution phase', () => {
      expect(
        spendTrip({ phase: null, budget, observedTokens: 1_000, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_000 } });
    });
  });

  describe('cost cap only, fully priced', () => {
    const budget = { tokens: null, costUsd: 10 };

    it('trips when the priced spend is over the cap', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: null, observedUsd: 15, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } });
    });

    it('trips exactly at the boundary (observedUsd === limit)', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: null, observedUsd: 10, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 10 } });
    });

    it('does not trip when the priced spend is under the cap', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: null, observedUsd: 5, costIncomplete: false }),
      ).toEqual({ kind: 'ok' });
    });
  });

  describe('cost cap, priced floor over cap but costIncomplete', () => {
    const budget = { tokens: null, costUsd: 10 };

    it('still trips on cost — a floor over the cap is trustworthy regardless of incompleteness', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: 500, observedUsd: 15, costIncomplete: true }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } });
    });
  });

  describe('cost cap unpriced/incomplete under cap, with a token fallback configured', () => {
    const budgetWithTokens = { tokens: 1_000, costUsd: 10 };

    it('observedUsd null falls back to the token budget and trips over', () => {
      expect(
        spendTrip({
          phase: 'executing',
          budget: budgetWithTokens,
          observedTokens: 1_500,
          observedUsd: null,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } });
    });

    it('observedUsd null falls back to the token budget and stays ok when under', () => {
      expect(
        spendTrip({
          phase: 'executing',
          budget: budgetWithTokens,
          observedTokens: 500,
          observedUsd: null,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('costIncomplete with a floor under the cap falls back to the token budget and trips over', () => {
      expect(
        spendTrip({
          phase: 'executing',
          budget: budgetWithTokens,
          observedTokens: 1_500,
          observedUsd: 5,
          costIncomplete: true,
        }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } });
    });

    it('costIncomplete with a floor under the cap falls back to the token budget and stays ok when under', () => {
      expect(
        spendTrip({
          phase: 'executing',
          budget: budgetWithTokens,
          observedTokens: 500,
          observedUsd: 5,
          costIncomplete: true,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('falls back to the token budget and is unmeasurable when observedTokens is also null', () => {
      expect(
        spendTrip({
          phase: 'executing',
          budget: budgetWithTokens,
          observedTokens: null,
          observedUsd: null,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'tokens' });
    });
  });

  describe('cost cap unpriced, with NO token fallback configured', () => {
    const budget = { tokens: null, costUsd: 10 };

    it('is unmeasurable on cost when observedUsd is null', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: null, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'cost' });
    });

    it('is unmeasurable on cost when costIncomplete is true, even with a floor under the cap', () => {
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: null, observedUsd: 2, costIncomplete: true }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'cost' });
    });
  });

  describe('both caps set: cost fully priced under cap, tokens over cap', () => {
    it('falls through to the independent token cap and trips', () => {
      const budget = { tokens: 1_000, costUsd: 10 };
      expect(
        spendTrip({
          phase: 'executing',
          budget,
          observedTokens: 1_500,
          observedUsd: 5,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } });
    });

    it('falls through to the independent token cap and stays ok when both are under', () => {
      const budget = { tokens: 1_000, costUsd: 10 };
      expect(
        spendTrip({
          phase: 'executing',
          budget,
          observedTokens: 500,
          observedUsd: 5,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'ok' });
    });
  });

  describe('non-execution phases never trip, no matter how far over budget', () => {
    const budget = { tokens: 1_000, costUsd: 10 };

    for (const phase of nonExecutionPhases) {
      it(`${phase} -> ok even with everything massively over cap`, () => {
        expect(
          spendTrip({
            phase,
            budget,
            observedTokens: 1_000_000,
            observedUsd: 1_000,
            costIncomplete: false,
          }),
        ).toEqual({ kind: 'ok' });
      });
    }
  });

  describe('no caps configured', () => {
    it('is always ok regardless of observed usage', () => {
      const budget = { tokens: null, costUsd: null };
      expect(
        spendTrip({ phase: 'executing', budget, observedTokens: 1_000_000, observedUsd: 1_000, costIncomplete: true }),
      ).toEqual({ kind: 'ok' });
    });
  });
});
