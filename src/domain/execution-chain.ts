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
 * contract can be exhaustively unit-tested in isolation. The Runner's
 * spend-guard poll (`runner.ts`, `armSpendGuardrail`) is the live caller: it
 * reads this Run's prior chain members via `ExecutionChainStore.listForChain`,
 * folds them here, and Escalates through the same `guardrail-trip` machinery as
 * the per-Run guard when `combineSpendOutcomes` reports a chain-scoped trip.
 * This module owns only the *decision*; the I/O lives in the Runner and the
 * store.
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
 * The carried-forward spend floor of a chain's already-settled prior members,
 * as produced by `sumPriorSpend` and consumed by `chainObserved`. Distinct from
 * `ChainSpend`: the token/usd figures are never null here (a settled member's
 * unmeasured dimension contributes a `0` floor), and the two `*Incomplete`
 * flags carry whether that floor is trustworthy or a possible under-count.
 */
export interface PriorSpend {
  tokens: number;
  usd: number;
  /** A prior member's cost was unpriced/unmeasured — the `usd` floor may under-count. */
  costIncomplete: boolean;
  /** A prior member's tokens were never recorded — the `tokens` floor may under-count. */
  tokensIncomplete: boolean;
}

/**
 * Fold the already-settled prior member Runs of a chain into the
 * carried-forward spend floor that `chainObserved` adds the live Run's
 * spend on top of.
 *
 * `tokens` sums every member's `tokens`, treating a null (unmeasurable)
 * member as contributing `0` to the floor — but records that under-count in
 * `tokensIncomplete` so `chainObserved` can refuse to trust a floor that may
 * be missing a member's spend. This matters for issue #129's core criterion
 * ("a retry cannot reset the counter to bypass the ceiling"): a member that
 * burned tokens but crashed before its usage persisted would otherwise fold
 * to `0` and silently reset the token counter for that member's spend. So the
 * floor stays a definite lower bound (never null — a floor already over the
 * cap is still a real trip), while `tokensIncomplete` marks it as possibly
 * short, and `chainObserved` turns "under the cap but possibly short" into an
 * *unmeasurable* token reading (→ the Runner's grace-then-Escalate path)
 * rather than a false "ok". `usd` follows the identical null-contributes-0
 * rule, with `costIncomplete` (already `spendTrip`'s cost-incompleteness
 * channel) playing `tokensIncomplete`'s role for the cost dimension — true if
 * ANY member has `usd === null` or its own `costIncomplete` set.
 *
 * An empty chain (no prior members — the live Run is the first in its chain)
 * folds to a zero floor with both `*Incomplete` flags false, so
 * `chainObserved` degrades to exactly the live Run's own spend and the chain
 * outcome is identical to the per-Run outcome (see `combineSpendOutcomes`'s
 * single-Run-chain note).
 */
export function sumPriorSpend(members: ChainSpend[]): PriorSpend {
  let tokens = 0;
  let usd = 0;
  let costIncomplete = false;
  let tokensIncomplete = false;

  for (const member of members) {
    tokens += member.tokens ?? 0;
    usd += member.usd ?? 0;
    if (member.tokens === null) tokensIncomplete = true;
    if (member.usd === null || member.costIncomplete) costIncomplete = true;
  }

  return { tokens, usd, costIncomplete, tokensIncomplete };
}

/**
 * Fold the live Run's current-poll spend onto the `sumPriorSpend` floor to
 * get the chain-cumulative observed spend to feed into `spendTrip`.
 *
 * `tokens` is null (unmeasurable) when the live figure is null OR the prior
 * floor is `tokensIncomplete`: the live Run's own unmeasurability this poll
 * dominates, and an incomplete prior floor is equally untrustworthy — folding
 * an under-counted floor into a concrete sum would understate the true
 * (unknown) total and let a crashed predecessor's unrecorded spend silently
 * reset the counter (issue #129's "a retry cannot reset the counter" hole).
 * Reporting null here routes both cases through `spendTrip`'s
 * null-means-unmeasurable convention and the Runner's grace-then-Escalate
 * path, an honest "can't confirm under budget" rather than a false "ok". When
 * the live figure is measurable AND the prior floor is complete, the fold is
 * the plain cumulative `live.tokens + prior.tokens`. `usd` follows the
 * identical rule against `prior.costIncomplete` — except a `usd` *floor*
 * already at/over the cap is a definite cost trip regardless of
 * incompleteness (see `spendTrip`), so a complete-enough overshoot is not
 * suppressed; `costIncomplete` is carried through as the OR of both for
 * `spendTrip` to weigh.
 *
 * Because every prior member already passed its own per-Run `spendTrip`
 * check before being folded into `prior`, the prior floor by itself is
 * always under the cap — no prior member could have settled while over its
 * own budget. So (when measurable) `chainObserved(prior, live)` trips only
 * when the live Run's own contribution pushes the cumulative over the line:
 * exactly issue #129's "a retry cannot reset the counter" behaviour, since
 * the counter the live Run inherits is never reset back to zero by starting a
 * new attempt.
 */
export function chainObserved(prior: PriorSpend, live: ChainSpend): ChainSpend {
  return {
    tokens: live.tokens === null || prior.tokensIncomplete ? null : live.tokens + prior.tokens,
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
