import { describe, expect, it } from 'vitest';
import {
  EXECUTION_BUDGET_STEPS,
  countsTowardExecutionBudget,
  formatBudgetReason,
  formatUnmeasurableReason,
  spendTrip,
  wallClockBudgetMs,
  wallClockTrip,
} from '../src/domain/guardrail-budget.js';
import { STEP_TYPES, type StepType } from '../src/db/schema.js';

describe('EXECUTION_BUDGET_STEPS (issue #127, ADR-0001 Vocabulary)', () => {
  it('is exactly rebase/implementation/verification/review — every Step type', () => {
    expect(new Set(EXECUTION_BUDGET_STEPS)).toEqual(new Set(['rebase', 'implementation', 'verification', 'review']));
  });
});

describe('countsTowardExecutionBudget (issue #127)', () => {
  const expected: Record<StepType, boolean> = {
    rebase: true,
    implementation: true,
    verification: true,
    review: true,
  };

  for (const stepType of STEP_TYPES) {
    it(`${stepType} -> ${expected[stepType]}`, () => {
      expect(countsTowardExecutionBudget(stepType)).toBe(expected[stepType]);
    });
  }

  it('null (no Step running — the gap before merge) does not count', () => {
    expect(countsTowardExecutionBudget(null)).toBe(false);
  });
});

describe('wallClockBudgetMs', () => {
  it('converts minutes to milliseconds', () => {
    expect(wallClockBudgetMs({ wallClockMinutes: 45 })).toBe(2_700_000);
    expect(wallClockBudgetMs({ wallClockMinutes: 1 })).toBe(60_000);
  });
});

describe('wallClockTrip (issue #127, the Step-scoping decision)', () => {
  const budget = { wallClockMinutes: 45 };

  it('trips when elapsed >= budget while any Step is running', () => {
    for (const stepType of STEP_TYPES) {
      expect(wallClockTrip({ elapsedMs: 3_000_000, stepType, budget })).toEqual({
        dimension: 'wall-clock',
        limitMs: 2_700_000,
        observedMs: 3_000_000,
      });
    }
  });

  it('does NOT trip when elapsed >= budget but no Step is running (core acceptance — the merge gap)', () => {
    expect(wallClockTrip({ elapsedMs: 100_000_000, stepType: null, budget })).toBeNull();
  });

  it('does not trip below budget while a Step is running', () => {
    expect(wallClockTrip({ elapsedMs: 2_699_999, stepType: 'implementation', budget })).toBeNull();
  });

  it('trips exactly at the boundary (elapsedMs === limitMs)', () => {
    expect(wallClockTrip({ elapsedMs: 2_700_000, stepType: 'verification', budget })).toEqual({
      dimension: 'wall-clock',
      limitMs: 2_700_000,
      observedMs: 2_700_000,
    });
  });

  it('the critic (review Step) counts identically to the command verifier (verification Step) — both are active verification work', () => {
    expect(wallClockTrip({ elapsedMs: 2_700_000, stepType: 'review', budget })).toEqual({
      dimension: 'wall-clock',
      limitMs: 2_700_000,
      observedMs: 2_700_000,
    });
  });

  it('trip payload carries the correct limitMs/observedMs for a different budget', () => {
    const smallBudget = { wallClockMinutes: 5 };
    expect(wallClockTrip({ elapsedMs: 450_000, stepType: 'implementation', budget: smallBudget })).toEqual({
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
  describe('token cap only', () => {
    const budget = { tokens: 1_000, costUsd: null };

    it('trips exactly at the boundary (observedTokens === limit)', () => {
      for (const stepType of STEP_TYPES) {
        expect(
          spendTrip({ stepType, budget, observedTokens: 1_000, observedUsd: null, costIncomplete: false }),
        ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_000 } });
      }
    });

    it('trips over the boundary', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: 1_500, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } });
    });

    it('does not trip below the boundary', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: 999, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'ok' });
    });

    it('is unmeasurable when observedTokens is null', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: null, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'tokens' });
    });

    it('null stepType (no Step running) is never governed, however far over the cap', () => {
      expect(
        spendTrip({ stepType: null, budget, observedTokens: 1_000, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'ok' });
    });
  });

  describe('cost cap only, fully priced', () => {
    const budget = { tokens: null, costUsd: 10 };

    it('trips when the priced spend is over the cap', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: null, observedUsd: 15, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } });
    });

    it('trips exactly at the boundary (observedUsd === limit)', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: null, observedUsd: 10, costIncomplete: false }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 10 } });
    });

    it('does not trip when the priced spend is under the cap', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: null, observedUsd: 5, costIncomplete: false }),
      ).toEqual({ kind: 'ok' });
    });
  });

  describe('cost cap, priced floor over cap but costIncomplete', () => {
    const budget = { tokens: null, costUsd: 10 };

    it('still trips on cost — a floor over the cap is trustworthy regardless of incompleteness', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: 500, observedUsd: 15, costIncomplete: true }),
      ).toEqual({ kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } });
    });
  });

  describe('cost cap unpriced/incomplete under cap, with a token fallback configured', () => {
    const budgetWithTokens = { tokens: 1_000, costUsd: 10 };

    it('observedUsd null falls back to the token budget and trips over', () => {
      expect(
        spendTrip({
          stepType: 'implementation',
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
          stepType: 'implementation',
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
          stepType: 'implementation',
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
          stepType: 'implementation',
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
          stepType: 'implementation',
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
        spendTrip({ stepType: 'implementation', budget, observedTokens: null, observedUsd: null, costIncomplete: false }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'cost' });
    });

    it('is unmeasurable on cost when costIncomplete is true, even with a floor under the cap', () => {
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: null, observedUsd: 2, costIncomplete: true }),
      ).toEqual({ kind: 'unmeasurable', dimension: 'cost' });
    });
  });

  describe('both caps set: cost fully priced under cap, tokens over cap', () => {
    it('falls through to the independent token cap and trips', () => {
      const budget = { tokens: 1_000, costUsd: 10 };
      expect(
        spendTrip({
          stepType: 'implementation',
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
          stepType: 'implementation',
          budget,
          observedTokens: 500,
          observedUsd: 5,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'ok' });
    });
  });

  describe('no Step running never trips, no matter how far over budget', () => {
    const budget = { tokens: 1_000, costUsd: 10 };

    it('null stepType -> ok even with everything massively over cap', () => {
      expect(
        spendTrip({
          stepType: null,
          budget,
          observedTokens: 1_000_000,
          observedUsd: 1_000,
          costIncomplete: false,
        }),
      ).toEqual({ kind: 'ok' });
    });
  });

  describe('no caps configured', () => {
    it('is always ok regardless of observed usage', () => {
      const budget = { tokens: null, costUsd: null };
      expect(
        spendTrip({ stepType: 'implementation', budget, observedTokens: 1_000_000, observedUsd: 1_000, costIncomplete: true }),
      ).toEqual({ kind: 'ok' });
    });
  });
});
