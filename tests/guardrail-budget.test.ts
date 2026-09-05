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
  // Schema-driven so a new StepType can't slip the budget untested; literal expectation, not recomputed.
  const expected: Record<StepType, boolean> = {
    rebase: true,
    implementation: true,
    verification: true,
    review: true,
  };

  it.each(STEP_TYPES)('%s -> counts toward the budget', (stepType) => {
    expect(countsTowardExecutionBudget(stepType)).toBe(expected[stepType]);
  });

  it('null (no Step running — the gap before merge) does not count', () => {
    expect(countsTowardExecutionBudget(null)).toBe(false);
  });
});

describe('wallClockBudgetMs', () => {
  it.each([
    { wallClockMinutes: 45, expected: 2_700_000 },
    { wallClockMinutes: 1, expected: 60_000 },
  ])('converts $wallClockMinutes minutes to $expected ms', ({ wallClockMinutes, expected }) => {
    expect(wallClockBudgetMs({ wallClockMinutes })).toBe(expected);
  });
});

describe('wallClockTrip (issue #127, the Step-scoping decision)', () => {
  const budget = { wallClockMinutes: 45 };

  it.each(STEP_TYPES)('trips when elapsed >= budget while the %s Step is running', (stepType) => {
    expect(wallClockTrip({ elapsedMs: 3_000_000, stepType, budget })).toEqual({
      dimension: 'wall-clock',
      limitMs: 2_700_000,
      observedMs: 3_000_000,
    });
  });

  it.each<{ name: string; elapsedMs: number; stepType: StepType | null; budget: { wallClockMinutes: number }; expected: unknown }>([
    {
      name: 'does NOT trip when elapsed >= budget but no Step is running (core acceptance — the merge gap)',
      elapsedMs: 100_000_000,
      stepType: null,
      budget,
      expected: null,
    },
    {
      name: 'does not trip below budget while a Step is running',
      elapsedMs: 2_699_999,
      stepType: 'implementation',
      budget,
      expected: null,
    },
    {
      name: 'trips exactly at the boundary (elapsedMs === limitMs)',
      elapsedMs: 2_700_000,
      stepType: 'verification',
      budget,
      expected: { dimension: 'wall-clock', limitMs: 2_700_000, observedMs: 2_700_000 },
    },
    {
      // the critic (review Step) counts identically to the command verifier (verification Step)
      name: 'the review Step trips identically to the verification Step — both are active verification work',
      elapsedMs: 2_700_000,
      stepType: 'review',
      budget,
      expected: { dimension: 'wall-clock', limitMs: 2_700_000, observedMs: 2_700_000 },
    },
    {
      name: 'trip payload carries the correct limitMs/observedMs for a different budget',
      elapsedMs: 450_000,
      stepType: 'implementation',
      budget: { wallClockMinutes: 5 },
      expected: { dimension: 'wall-clock', limitMs: 300_000, observedMs: 450_000 },
    },
  ])('$name', ({ elapsedMs, stepType, budget: b, expected }) => {
    expect(wallClockTrip({ elapsedMs, stepType, budget: b })).toEqual(expected);
  });
});

describe('formatBudgetReason (issue #127, ADR-0019)', () => {
  // Names the configured bound at whichever unit keeps the number small; never the overshoot.
  it.each<{ name: string; trip: Parameters<typeof formatBudgetReason>[0]; expected: string }>([
    { name: '45-minute budget -> "budget: 45m"', trip: { dimension: 'wall-clock', limitMs: 2_700_000 }, expected: 'budget: 45m' },
    { name: '1-minute budget -> "budget: 1m"', trip: { dimension: 'wall-clock', limitMs: 60_000 }, expected: 'budget: 1m' },
    { name: 'sub-minute duration in seconds', trip: { dimension: 'wall-clock', limitMs: 45_000 }, expected: 'budget: 45s' },
    { name: 'exactly 1 second -> "budget: 1s"', trip: { dimension: 'wall-clock', limitMs: 1_000 }, expected: 'budget: 1s' },
    { name: 'sub-second duration in raw milliseconds', trip: { dimension: 'wall-clock', limitMs: 500 }, expected: 'budget: 500ms' },
    { name: 'token budget in millions', trip: { dimension: 'tokens', limitTokens: 2_000_000 }, expected: 'budget: 2M tokens' },
    { name: 'small token budget as a raw count', trip: { dimension: 'tokens', limitTokens: 500 }, expected: 'budget: 500 tokens' },
    { name: 'cost budget as whole dollars', trip: { dimension: 'cost', limitUsd: 10 }, expected: 'budget: $10' },
    { name: 'cost budget with cents', trip: { dimension: 'cost', limitUsd: 10.5 }, expected: 'budget: $10.5' },
  ])('renders a $name', ({ trip, expected }) => {
    expect(formatBudgetReason(trip)).toBe(expected);
  });
});

describe('formatUnmeasurableReason (issue #128)', () => {
  it.each<['tokens' | 'cost', string]>([
    ['tokens', 'budget: tokens unmeasurable'],
    ['cost', 'budget: cost unmeasurable'],
  ])('renders the %s dimension', (dimension, expected) => {
    expect(formatUnmeasurableReason(dimension)).toBe(expected);
  });
});

describe('spendTrip (issue #128, the token/cost spend decision)', () => {
  it.each(STEP_TYPES)('trips on the token cap at the boundary (observedTokens === limit) while %s runs', (stepType) => {
    expect(
      spendTrip({ stepType, budget: { tokens: 1_000, costUsd: null }, observedTokens: 1_000, observedUsd: null, costIncomplete: false }),
    ).toEqual({ kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_000 } });
  });

  type SpendArgs = Parameters<typeof spendTrip>[0];
  const tokenOnly = { tokens: 1_000, costUsd: null };
  const costOnly = { tokens: null, costUsd: 10 };
  const bothCaps = { tokens: 1_000, costUsd: 10 };

  it.each<{ name: string; args: SpendArgs; expected: unknown }>([
    // token cap only
    {
      name: 'token cap: trips over the boundary',
      args: { stepType: 'implementation', budget: tokenOnly, observedTokens: 1_500, observedUsd: null, costIncomplete: false },
      expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
    },
    {
      name: 'token cap: does not trip below the boundary',
      args: { stepType: 'implementation', budget: tokenOnly, observedTokens: 999, observedUsd: null, costIncomplete: false },
      expected: { kind: 'ok' },
    },
    {
      name: 'token cap: unmeasurable when observedTokens is null',
      args: { stepType: 'implementation', budget: tokenOnly, observedTokens: null, observedUsd: null, costIncomplete: false },
      expected: { kind: 'unmeasurable', dimension: 'tokens' },
    },
    {
      name: 'token cap: null stepType is never governed, however far over the cap',
      args: { stepType: null, budget: tokenOnly, observedTokens: 1_000, observedUsd: null, costIncomplete: false },
      expected: { kind: 'ok' },
    },
    // cost cap only, fully priced
    {
      name: 'cost cap: trips when the priced spend is over the cap',
      args: { stepType: 'implementation', budget: costOnly, observedTokens: null, observedUsd: 15, costIncomplete: false },
      expected: { kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } },
    },
    {
      name: 'cost cap: trips exactly at the boundary (observedUsd === limit)',
      args: { stepType: 'implementation', budget: costOnly, observedTokens: null, observedUsd: 10, costIncomplete: false },
      expected: { kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 10 } },
    },
    {
      name: 'cost cap: does not trip when the priced spend is under the cap',
      args: { stepType: 'implementation', budget: costOnly, observedTokens: null, observedUsd: 5, costIncomplete: false },
      expected: { kind: 'ok' },
    },
    // cost cap, priced floor over cap but costIncomplete — a floor over the cap is trustworthy regardless
    {
      name: 'cost cap: still trips on a floor over the cap even when costIncomplete',
      args: { stepType: 'implementation', budget: costOnly, observedTokens: 500, observedUsd: 15, costIncomplete: true },
      expected: { kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } },
    },
    // cost cap unpriced/incomplete under cap, with a token fallback configured
    {
      name: 'token fallback: observedUsd null falls back to the token budget and trips over',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: 1_500, observedUsd: null, costIncomplete: false },
      expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
    },
    {
      name: 'token fallback: observedUsd null falls back to the token budget and stays ok when under',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: 500, observedUsd: null, costIncomplete: false },
      expected: { kind: 'ok' },
    },
    {
      name: 'token fallback: costIncomplete with a floor under the cap falls back to tokens and trips over',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: 1_500, observedUsd: 5, costIncomplete: true },
      expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
    },
    {
      name: 'token fallback: costIncomplete with a floor under the cap falls back to tokens and stays ok when under',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: 500, observedUsd: 5, costIncomplete: true },
      expected: { kind: 'ok' },
    },
    {
      name: 'token fallback: unmeasurable when observedTokens is also null',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: null, observedUsd: null, costIncomplete: false },
      expected: { kind: 'unmeasurable', dimension: 'tokens' },
    },
    // cost cap unpriced, with NO token fallback configured
    {
      name: 'no fallback: unmeasurable on cost when observedUsd is null',
      args: { stepType: 'implementation', budget: costOnly, observedTokens: null, observedUsd: null, costIncomplete: false },
      expected: { kind: 'unmeasurable', dimension: 'cost' },
    },
    {
      name: 'no fallback: unmeasurable on cost when costIncomplete is true, even with a floor under the cap',
      args: { stepType: 'implementation', budget: costOnly, observedTokens: null, observedUsd: 2, costIncomplete: true },
      expected: { kind: 'unmeasurable', dimension: 'cost' },
    },
    // both caps set: cost fully priced under cap falls through to the independent token cap
    {
      name: 'both caps: cost under cap falls through to the token cap and trips',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: 1_500, observedUsd: 5, costIncomplete: false },
      expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
    },
    {
      name: 'both caps: cost under cap falls through to the token cap and stays ok when both are under',
      args: { stepType: 'implementation', budget: bothCaps, observedTokens: 500, observedUsd: 5, costIncomplete: false },
      expected: { kind: 'ok' },
    },
    // no Step running never trips, no matter how far over budget
    {
      name: 'no Step running -> ok even with everything massively over cap',
      args: { stepType: null, budget: bothCaps, observedTokens: 1_000_000, observedUsd: 1_000, costIncomplete: false },
      expected: { kind: 'ok' },
    },
    // no caps configured
    {
      name: 'no caps configured -> always ok regardless of observed usage',
      args: { stepType: 'implementation', budget: { tokens: null, costUsd: null }, observedTokens: 1_000_000, observedUsd: 1_000, costIncomplete: true },
      expected: { kind: 'ok' },
    },
  ])('$name', ({ args, expected }) => {
    expect(spendTrip(args)).toEqual(expected);
  });
});
