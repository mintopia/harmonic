import { describe, expect, it } from 'vitest';
import {
  formatBudgetReason,
  formatUnmeasurableReason,
  spendTrip,
  wallClockBudgetMs,
  wallClockTrip,
} from '../src/domain/guardrail-budget.js';
import { setBudgetField, summarizeBudget } from '../web/src/components/guardrail-budget-model.js';
import type { BudgetGuardrail } from '../web/src/types.js';

describe('guardrail budget decisions', () => {
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

    it.each<{ name: string; elapsedMs: number; budget: { wallClockMinutes: number }; expected: unknown }>([
      {
        name: 'does not trip below budget while a Step is running',
        elapsedMs: 2_699_999,
        budget,
        expected: null,
      },
      {
        name: 'trips exactly at the boundary (elapsedMs === limitMs)',
        elapsedMs: 2_700_000,
        budget,
        expected: { dimension: 'wall-clock', limitMs: 2_700_000, observedMs: 2_700_000 },
      },
      {
        name: 'trip payload carries the correct limitMs/observedMs for a different budget',
        elapsedMs: 450_000,
        budget: { wallClockMinutes: 5 },
        expected: { dimension: 'wall-clock', limitMs: 300_000, observedMs: 450_000 },
      },
    ])('$name', ({ elapsedMs, budget: b, expected }) => {
      expect(wallClockTrip({ elapsedMs, budget: b })).toEqual(expected);
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
    it('trips on the token cap at the boundary (observedTokens === limit)', () => {
      expect(
        spendTrip({ budget: { tokens: 1_000, costUsd: null }, observedTokens: 1_000, observedUsd: null, costIncomplete: false }),
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
        args: { budget: tokenOnly, observedTokens: 1_500, observedUsd: null, costIncomplete: false },
        expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
      },
      {
        name: 'token cap: does not trip below the boundary',
        args: { budget: tokenOnly, observedTokens: 999, observedUsd: null, costIncomplete: false },
        expected: { kind: 'ok' },
      },
      {
        name: 'token cap: unmeasurable when observedTokens is null',
        args: { budget: tokenOnly, observedTokens: null, observedUsd: null, costIncomplete: false },
        expected: { kind: 'unmeasurable', dimension: 'tokens' },
      },
      // cost cap only, fully priced
      {
        name: 'cost cap: trips when the priced spend is over the cap',
        args: { budget: costOnly, observedTokens: null, observedUsd: 15, costIncomplete: false },
        expected: { kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } },
      },
      {
        name: 'cost cap: trips exactly at the boundary (observedUsd === limit)',
        args: { budget: costOnly, observedTokens: null, observedUsd: 10, costIncomplete: false },
        expected: { kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 10 } },
      },
      {
        name: 'cost cap: does not trip when the priced spend is under the cap',
        args: { budget: costOnly, observedTokens: null, observedUsd: 5, costIncomplete: false },
        expected: { kind: 'ok' },
      },
      // cost cap, priced floor over cap but costIncomplete — a floor over the cap is trustworthy regardless
      {
        name: 'cost cap: still trips on a floor over the cap even when costIncomplete',
        args: { budget: costOnly, observedTokens: 500, observedUsd: 15, costIncomplete: true },
        expected: { kind: 'trip', trip: { dimension: 'cost', limitUsd: 10, observedUsd: 15 } },
      },
      // cost cap unpriced/incomplete under cap, with a token fallback configured
      {
        name: 'token fallback: observedUsd null falls back to the token budget and trips over',
        args: { budget: bothCaps, observedTokens: 1_500, observedUsd: null, costIncomplete: false },
        expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
      },
      {
        name: 'token fallback: observedUsd null falls back to the token budget and stays ok when under',
        args: { budget: bothCaps, observedTokens: 500, observedUsd: null, costIncomplete: false },
        expected: { kind: 'ok' },
      },
      {
        name: 'token fallback: costIncomplete with a floor under the cap falls back to tokens and trips over',
        args: { budget: bothCaps, observedTokens: 1_500, observedUsd: 5, costIncomplete: true },
        expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
      },
      {
        name: 'token fallback: costIncomplete with a floor under the cap falls back to tokens and stays ok when under',
        args: { budget: bothCaps, observedTokens: 500, observedUsd: 5, costIncomplete: true },
        expected: { kind: 'ok' },
      },
      {
        name: 'token fallback: unmeasurable when observedTokens is also null',
        args: { budget: bothCaps, observedTokens: null, observedUsd: null, costIncomplete: false },
        expected: { kind: 'unmeasurable', dimension: 'tokens' },
      },
      // cost cap unpriced, with NO token fallback configured
      {
        name: 'no fallback: unmeasurable on cost when observedUsd is null',
        args: { budget: costOnly, observedTokens: null, observedUsd: null, costIncomplete: false },
        expected: { kind: 'unmeasurable', dimension: 'cost' },
      },
      {
        name: 'no fallback: unmeasurable on cost when costIncomplete is true, even with a floor under the cap',
        args: { budget: costOnly, observedTokens: null, observedUsd: 2, costIncomplete: true },
        expected: { kind: 'unmeasurable', dimension: 'cost' },
      },
      // both caps set: cost fully priced under cap falls through to the independent token cap
      {
        name: 'both caps: cost under cap falls through to the token cap and trips',
        args: { budget: bothCaps, observedTokens: 1_500, observedUsd: 5, costIncomplete: false },
        expected: { kind: 'trip', trip: { dimension: 'tokens', limitTokens: 1_000, observedTokens: 1_500 } },
      },
      {
        name: 'both caps: cost under cap falls through to the token cap and stays ok when both are under',
        args: { budget: bothCaps, observedTokens: 500, observedUsd: 5, costIncomplete: false },
        expected: { kind: 'ok' },
      },
      // no caps configured
      {
        name: 'no caps configured -> always ok regardless of observed usage',
        args: { budget: { tokens: null, costUsd: null }, observedTokens: 1_000_000, observedUsd: 1_000, costIncomplete: true },
        expected: { kind: 'ok' },
      },
    ])('$name', ({ args, expected }) => {
      expect(spendTrip(args)).toEqual(expected);
    });
  });
});

describe('guardrail budget web model', () => {
  const base: BudgetGuardrail = { wallClockMinutes: 60, tokens: null, costUsd: null };

  describe('setBudgetField (issue #166)', () => {
    it('sets the mandatory wall-clock from a numeric input', () => {
      expect(setBudgetField(base, 'wallClockMinutes', '30')).toEqual({ wallClockMinutes: 30, tokens: null, costUsd: null });
    });

    it('keeps the prior wall-clock on a blank input — it can never go null', () => {
      expect(setBudgetField(base, 'wallClockMinutes', '')).toEqual(base);
    });

    it('keeps the prior wall-clock on a non-numeric input', () => {
      expect(setBudgetField(base, 'wallClockMinutes', 'abc')).toEqual(base);
    });

    it('sets an opt-in token cap from a number', () => {
      expect(setBudgetField(base, 'tokens', '500000')).toEqual({ wallClockMinutes: 60, tokens: 500000, costUsd: null });
    });

    it('clears an opt-in cap to null on a blank input, leaving the others', () => {
      const withCaps: BudgetGuardrail = { wallClockMinutes: 60, tokens: 500000, costUsd: 5 };
      expect(setBudgetField(withCaps, 'tokens', '')).toEqual({ wallClockMinutes: 60, tokens: null, costUsd: 5 });
      expect(setBudgetField(withCaps, 'costUsd', '')).toEqual({ wallClockMinutes: 60, tokens: 500000, costUsd: null });
    });

    it('sets a fractional cost cap', () => {
      expect(setBudgetField(base, 'costUsd', '2.50')).toEqual({ wallClockMinutes: 60, tokens: null, costUsd: 2.5 });
    });

    it('ignores a non-numeric cap edit, keeping the prior value', () => {
      const withCap: BudgetGuardrail = { wallClockMinutes: 60, tokens: 500000, costUsd: null };
      expect(setBudgetField(withCap, 'tokens', 'lots')).toEqual(withCap);
    });
  });

  describe('summarizeBudget (issue #166)', () => {
    it('shows only the wall-clock bound when no caps are set', () => {
      expect(summarizeBudget(base)).toBe('60 min wall-clock');
    });

    it('appends each opt-in cap that is set', () => {
      expect(summarizeBudget({ wallClockMinutes: 30, tokens: 2000000, costUsd: 10 })).toBe(
        '30 min wall-clock · 2000000 tokens · $10',
      );
    });
  });
});
