import type { BudgetGuardrail } from '../types.js';

/**
 * Budget-Guardrail override editing (ADR-0019, issue #166). The Workspace budget
 * override is a whole object behind one inheritance toggle (unlike the scalar
 * overrides), so these pure helpers fold a text-input edit into the object and
 * summarise it for the inheriting read-only line — kept here so the shaping is
 * testable without a DOM.
 */

/** A budget dimension the operator edits. Wall-clock is mandatory; the caps opt in. */
export type BudgetField = 'wallClockMinutes' | 'tokens' | 'costUsd';

/**
 * Fold a raw text-input value into the budget object. `wallClockMinutes` is
 * mandatory — a blank or non-numeric input keeps the prior value rather than
 * dropping the only guaranteed bound. `tokens` and `costUsd` are opt-in caps:
 * a blank input clears that cap to `null` (no limit), a number sets it. A
 * non-numeric non-blank input is ignored (the prior value stands).
 */
export function setBudgetField(budget: BudgetGuardrail, field: BudgetField, raw: string): BudgetGuardrail {
  const trimmed = raw.trim();
  if (field === 'wallClockMinutes') {
    const n = Number(trimmed);
    return trimmed === '' || Number.isNaN(n) ? budget : { ...budget, wallClockMinutes: n };
  }
  if (trimmed === '') return { ...budget, [field]: null };
  const n = Number(trimmed);
  return Number.isNaN(n) ? budget : { ...budget, [field]: n };
}

/**
 * One-line summary of a budget for the inheriting read-only display: the
 * wall-clock bound always, then each opt-in cap that is set. Mirrors how the
 * override reads so inheriting-vs-overriding shows the same shape.
 */
export function summarizeBudget(budget: BudgetGuardrail): string {
  const parts = [`${budget.wallClockMinutes} min wall-clock`];
  if (budget.tokens != null) parts.push(`${budget.tokens} tokens`);
  if (budget.costUsd != null) parts.push(`$${budget.costUsd}`);
  return parts.join(' · ');
}
