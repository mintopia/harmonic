/**
 * The Execution Chain's cumulative spend decision (issue #129), extending
 * #128's per-Run `spendTrip` to the "a retry cannot reset the counter"
 * acceptance criterion.
 *
 * A chain is the ordered sequence of Runs produced when a Run is retried
 * (self-heal, re-merge turn, operator retry, ...) against the same logical
 * unit of work. #128's `spendTrip` only ever sees a single Run's own usage,
 * so a chain that keeps retrying — each individual Run staying comfortably
 * under the per-Run cap — can burn an unbounded multiple of the configured
 * budget across the chain as a whole. This module is the pure arithmetic
 * that folds a chain's already-settled prior spend into a floor, folds the
 * live Run's current-poll spend on top of that floor, and picks the
 * effective outcome between the per-Run and chain-cumulative `spendTrip`
 * results — no database, no clock, no I/O, the same seam as
 * `guardrail-budget.ts` and `run-disposition.ts`, so the fold-and-combine
 * contract can be exhaustively unit-tested in isolation. Nothing calls this
 * from the live drive loop yet; that wiring (reading prior chain members,
 * appending the chain-scoped `guardrail-trip` run_fact) is later spine work.
 * This unit only has to get the *decision* right.
 */

import type { SpendOutcome } from './guardrail-budget.js';

/**
 * One Run's (or the live snapshot's) spend contribution to a chain.
 * `tokens`/`usd` are null when that dimension is unmeasurable (no usage
 * telemetry / unpriced) — mirroring `spendTrip`'s `observedTokens`/
 * `observedUsd` inputs, which is deliberate: a `ChainSpend` is exactly the
 * shape of evidence a single Run can offer toward the chain-cumulative
 * picture, whether it's a settled prior member or the live poll.
 */
export interface ChainSpend {
  tokens: number | null;
  usd: number | null;
  costIncomplete: boolean;
}

/**
 * Fold the already-settled prior member Runs of a chain into the
 * carried-forward spend floor that `chainObserved` adds the live Run's
 * spend on top of.
 *
 * `tokens` sums every member's `tokens`, treating a null (unmeasurable)
 * member as contributing `0` rather than poisoning the whole fold to null.
 * The result is deliberately a *floor*, never null: a member whose usage was
 * never recorded (a crash mid-Run before telemetry landed, say) shouldn't
 * make the entire chain's cumulative unmeasurable forever after — and every
 * prior member already passed its own per-Run `spendTrip` check when it was
 * live, so none of them individually pushed the chain over the cap; the
 * only open question the chain guard exists to answer is whether the *sum*
 * has. `usd` follows the identical null-contributes-0 rule for the same
 * reason. `costIncomplete` is true if ANY member has `usd === null` (an
 * unpriced/unmeasured member is itself a form of incompleteness) or has
 * `costIncomplete` set — incompleteness never heals by summing more numbers
 * on top of it.
 *
 * An empty chain (no prior members — the live Run is the first in its
 * chain) folds to a zero floor with `costIncomplete: false`, so
 * `chainObserved` degrades to exactly the live Run's own spend and the
 * chain outcome is identical to the per-Run outcome (see
 * `combineSpendOutcomes`'s single-Run-chain note).
 */
export function sumPriorSpend(members: ChainSpend[]): { tokens: number; usd: number; costIncomplete: boolean } {
  let tokens = 0;
  let usd = 0;
  let costIncomplete = false;

  for (const member of members) {
    tokens += member.tokens ?? 0;
    usd += member.usd ?? 0;
    if (member.usd === null || member.costIncomplete) costIncomplete = true;
  }

  return { tokens, usd, costIncomplete };
}

/**
 * Fold the live Run's current-poll spend onto the `sumPriorSpend` floor to
 * get the chain-cumulative observed spend to feed into `spendTrip`.
 *
 * `tokens`/`usd` are null iff the corresponding live figure is null: the
 * live Run's own unmeasurability this poll dominates, because a chain
 * cumulative that silently substituted the prior floor for an unmeasurable
 * live figure would understate the true (unknown) total rather than
 * honestly reporting that it can't be measured right now — matching
 * `spendTrip`'s own null-means-unmeasurable convention rather than treating
 * null as zero (the way `sumPriorSpend` treats a *settled* member's null,
 * where the member is done accruing and can never contribute more).
 * `costIncomplete` is the OR of both, for the same never-heals-by-summing
 * reason as `sumPriorSpend`.
 *
 * Because every prior member already passed its own per-Run `spendTrip`
 * check before being folded into `prior`, the prior floor by itself is
 * always under the cap — no prior member could have settled while over its
 * own budget. So feeding `chainObserved(prior, live)` into `spendTrip`
 * trips only when the live Run's own contribution pushes the cumulative
 * over the line: exactly issue #129's "a retry cannot reset the counter"
 * behaviour, since the counter the live Run inherits is never reset back to
 * zero by starting a new attempt.
 */
export function chainObserved(
  prior: { tokens: number; usd: number; costIncomplete: boolean },
  live: ChainSpend,
): ChainSpend {
  return {
    tokens: live.tokens === null ? null : live.tokens + prior.tokens,
    usd: live.usd === null ? null : live.usd + prior.usd,
    costIncomplete: live.costIncomplete || prior.costIncomplete,
  };
}

/**
 * Combine the per-Run spend outcome and the chain-cumulative spend outcome
 * (both produced by `spendTrip` against the SAME frozen `BudgetGuardrail`
 * caps — one fed the live Run's own usage, the other fed
 * `chainObserved`'s cumulative) into the single effective outcome the
 * Runner acts on.
 *
 * This is issue #129's "either the per-Run or the chain budget trips"
 * acceptance criterion, expressed as a precedence order rather than a
 * merge, because the two outcomes can never both usefully apply at once —
 * only one card is shown, one Escalate is raised. Precedence, in order:
 *
 * 1. `runOutcome.kind === 'trip'` wins outright, scope `'run'` — a Run that
 *    has individually blown its own per-Run cap is reported as exactly
 *    that, matching #128's existing behaviour and reason text unchanged
 *    even once #129's chain guard is wired in alongside it.
 * 2. Else `chainOutcome.kind === 'trip'` wins, scope `'chain'` — the Run
 *    itself is within its own per-Run budget, but the chain it belongs to
 *    (this attempt plus its settled predecessors) has crossed the cap. This
 *    is the case #129 exists to add: a bounded sequence of individually
 *    "fine" retries that cumulatively runs away.
 * 3./4. Neither trips: `unmeasurable` is preferred the same way, run before
 *    chain, so a configured-but-untelemetered per-Run guard still reports
 *    exactly as it did under #128 rather than being shadowed by the chain
 *    guard.
 * 5. Otherwise both are `ok`, and the combined result is `ok` with scope
 *    `'run'` (an arbitrary-but-stable choice among the two `ok`s).
 *
 * For a single-Run chain (no prior members — see `sumPriorSpend`'s empty
 * case), the prior floor is all-zero, so `chainObserved` returns exactly
 * the live Run's own `ChainSpend` and `chainOutcome` is identical to
 * `runOutcome`. The precedence above then leaves `scope` at `'run'` in
 * every branch, so a first-attempt Run's behaviour is byte-for-byte
 * identical to #128 — #129 only changes anything once a chain has more than
 * one member.
 */
export function combineSpendOutcomes(
  runOutcome: SpendOutcome,
  chainOutcome: SpendOutcome,
): { outcome: SpendOutcome; scope: 'run' | 'chain' } {
  if (runOutcome.kind === 'trip') return { outcome: runOutcome, scope: 'run' };
  if (chainOutcome.kind === 'trip') return { outcome: chainOutcome, scope: 'chain' };
  if (runOutcome.kind === 'unmeasurable') return { outcome: runOutcome, scope: 'run' };
  if (chainOutcome.kind === 'unmeasurable') return { outcome: chainOutcome, scope: 'chain' };
  return { outcome: { kind: 'ok' }, scope: 'run' };
}
