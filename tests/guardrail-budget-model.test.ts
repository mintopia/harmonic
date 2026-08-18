import { describe, expect, it } from 'vitest';
import { setBudgetField, summarizeBudget } from '../web/src/components/guardrail-budget-model.js';
import type { BudgetGuardrail } from '../web/src/types.js';

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
