/**
 * Retry & reject continuation in the same Session (issue #147, reliability-design
 * Unit C).
 *
 * When a Run is retried or its result rejected, the follow-up work should
 * continue **in the existing Session** — the same ACP conversation — so the agent
 * still remembers what it already tried and the feedback it just received, rather
 * than re-deriving everything from a cold start. This seam is the pure decision
 * of *how* that continuation is offered:
 *
 * - An **automated** trigger — an automatic retry, or the verify-agent (the #109
 *   critic) rejecting within seconds — reuses the warm Session **silently**: no
 *   operator dialog, the follow-up turn just lands on the same Session.
 * - A **human** rejection surfaces a **choice**: "continue the full conversation
 *   (with an estimated cost)" vs "start a condensed new Session". The choice is
 *   gated on **cost**, never on an elapsed-time clock.
 *
 * Cache warmth is the cost signal that informs — but never gates — that choice:
 * `estimatedWarmUntil` / `lastActiveAt` say whether the provider prompt cache is
 * likely still primed, so a full continuation is cheap (cache hit) or dear (the
 * whole conversation re-primes). It is **never a correctness gate**: a cold
 * Session can still be continued in full; it just costs more, and the operator
 * decides. There is no keepalive — the estimate only reads what is already
 * recorded, it never schedules anything to keep a Session warm.
 *
 * Like its sibling seams (`session-resume.ts` #142, `session-fallback.ts` #145,
 * `run-disposition.ts` #112) this is a **pure decision**: no database, no clock,
 * no I/O. The caller reads the trigger and the Session's warmth facts and passes
 * them in with an explicit `now`; recomputing over the same inputs always yields
 * the same plan, so every branch is exhaustively unit-testable in isolation. The
 * live wiring — bind the follow-up Run to the same Session, render the dialog,
 * seed the condensed alternative (via `buildResumeFallbackSummary`) — is the
 * caller's; this file only decides.
 */

import type { SessionRow } from '../db/schema.js';

/**
 * What prompted the continuation. Two are **automated** (they reuse the Session
 * silently); one is a **human** rejection (it surfaces the cost-gated choice).
 * The array is the single source of truth — the union type and the automated Set
 * below are derived from it, so a new trigger is ranked in exactly one place.
 */
export const CONTINUATION_TRIGGERS = [
  /** Harmonic re-ran the work itself after a transient/interrupted failure. */
  'automatic-retry',
  /** The verify-agent (the #109 verification gate) rejected the result — an
   * automated critic that fires within seconds, while the Session is still warm. */
  'verify-reject',
  /** An operator rejected the result with feedback — the only trigger that
   * surfaces the "continue full vs condensed new" choice. */
  'human-reject',
] as const;
export type ContinuationTrigger = (typeof CONTINUATION_TRIGGERS)[number];

/**
 * The triggers Harmonic fires without a human in the loop — they reuse the warm
 * Session silently, with no dialog and no cost gate. `human-reject` is the sole
 * trigger *not* in this set, so it is the only one that surfaces the choice.
 */
export const AUTOMATED_CONTINUATION_TRIGGERS = ['automatic-retry', 'verify-reject'] as const satisfies readonly ContinuationTrigger[];
export type AutomatedContinuationTrigger = (typeof AUTOMATED_CONTINUATION_TRIGGERS)[number];

const AUTOMATED_TRIGGER_SET: ReadonlySet<ContinuationTrigger> = new Set(AUTOMATED_CONTINUATION_TRIGGERS);

/** Whether `trigger` is one Harmonic fires automatically (silent warm reuse), as
 * opposed to a human rejection (which surfaces the cost-gated choice) — the
 * runtime counterpart of {@link AutomatedContinuationTrigger}. */
export function isAutomatedTrigger(trigger: ContinuationTrigger): trigger is AutomatedContinuationTrigger {
  return AUTOMATED_TRIGGER_SET.has(trigger);
}

/**
 * The facet of a stored Session the cost estimate reads — exactly the two warmth
 * fields. A whole {@link SessionRow} is structurally assignable, so callers pass
 * the row directly (or the {@link sessionWarmthFacts} projection); the narrow
 * shape keeps the pure decision independent of the rest of the Session record.
 */
export interface SessionWarmthFacts {
  /** Estimated epoch-ms at which the provider prompt cache goes cold (a per-
   * Harness COST estimate, `estimateWarmUntil` in sessions.ts), or `null` when
   * the harness has no known warm window — the *absence* of an estimate, never a
   * claim the Session is instantly cold. */
  estimatedWarmUntil: number | null;
  /** Epoch-ms of the Session's last dispatch/prompt activity — the freshness
   * anchor the estimate reports alongside the warmth verdict. */
  lastActiveAt: number;
}

/**
 * How warm the Session's prompt cache is likely to be — the qualitative cost
 * band a full continuation faces. Deliberately three coarse states, not a
 * time-bucketed clock: the design gates the human choice on *cost*, so inventing
 * fine-grained elapsed-time thresholds here would be exactly the TTL gate it
 * rejects.
 * - `warm`: `now` is within the estimated warm window — a full continuation
 *   likely hits the cache, so its incremental cost is low.
 * - `cold`: the estimated warm window has lapsed — a full continuation re-primes
 *   the whole conversation, so it costs materially more (but is still allowed).
 * - `unknown`: the harness has no known warm window (`estimatedWarmUntil` null),
 *   so warmth — and therefore the full-continuation cost — cannot be estimated.
 */
export type WarmthBand = 'warm' | 'cold' | 'unknown';

/**
 * The cost signal shown alongside the "continue full" option (issue #147 AC3/AC4).
 * A read-only estimate derived from the Session's warmth facts and `now` — never
 * a promise, never a gate. `band` is the headline; the raw deltas are carried so
 * the UI can render its own copy without re-deriving them.
 */
export interface ContinuationCostEstimate {
  /** The qualitative warmth/cost band (see {@link WarmthBand}). */
  band: WarmthBand;
  /** Best-effort: is the prompt cache likely still primed? `false` when `cold`
   * *or* `unknown` — a false here never blocks continuation, it only raises the
   * estimated cost shown to the operator. */
  warm: boolean;
  /** Whether the harness even has a warm-window estimate. `false` ⇒ `band` is
   * `unknown` (`estimatedWarmUntil` was null); the operator sees "cost unknown",
   * not a fabricated warm/cold claim. */
  warmthKnown: boolean;
  /** The estimate's inputs, echoed for the UI. */
  estimatedWarmUntil: number | null;
  /** `now - lastActiveAt`: how long since the Session last did anything. */
  msSinceActive: number;
  /** `estimatedWarmUntil - now` when known (negative once the window has
   * lapsed), or `null` when the harness has no warm window. */
  msUntilCold: number | null;
  /** A human-legible one-liner for the dialog — states the cost signal as a
   * signal, never a guarantee. */
  note: string;
}

/**
 * The plan for how a continuation is offered.
 * - `silent-continue`: an automated trigger — reuse the same Session with no
 *   operator dialog. `sameSession` is always true; there is no cost gate.
 * - `offer-choice`: a human rejection — surface the two options. `continueFull`
 *   continues the **same** Session (full conversation) and carries the cost
 *   {@link ContinuationCostEstimate}; `startCondensed` starts a **new** Session
 *   seeded with a condensed summary. Both are always available — warmth informs
 *   the estimate, it never removes an option.
 */
export type SessionContinuationPlan =
  | { mode: 'silent-continue'; trigger: AutomatedContinuationTrigger; sameSession: true }
  | {
      mode: 'offer-choice';
      trigger: 'human-reject';
      continueFull: { session: 'same'; conversation: 'full'; estimate: ContinuationCostEstimate };
      startCondensed: { session: 'new'; conversation: 'condensed' };
    };

/**
 * Estimate the cost of continuing the **full** conversation in `warmth`'s Session
 * as of `now` (issue #147 AC4). Pure and total: it reads only the two recorded
 * warmth fields and the passed clock, so recomputing over the same inputs always
 * yields the same estimate. Warmth is reported as a *cost* band, never a gate —
 * `cold` and `unknown` both still permit a full continuation, they only raise the
 * cost the caller shows.
 */
export function estimateContinuationCost(warmth: SessionWarmthFacts, now: number): ContinuationCostEstimate {
  const msSinceActive = now - warmth.lastActiveAt;
  if (warmth.estimatedWarmUntil === null) {
    return {
      band: 'unknown',
      warm: false,
      warmthKnown: false,
      estimatedWarmUntil: null,
      msSinceActive,
      msUntilCold: null,
      note: 'This harness has no known prompt-cache warm window, so the cost of continuing the full conversation cannot be estimated; it is still allowed.',
    };
  }
  const msUntilCold = warmth.estimatedWarmUntil - now;
  const warm = msUntilCold >= 0;
  return {
    band: warm ? 'warm' : 'cold',
    warm,
    warmthKnown: true,
    estimatedWarmUntil: warmth.estimatedWarmUntil,
    msSinceActive,
    msUntilCold,
    note: warm
      ? 'The prompt cache is likely still warm, so continuing the full conversation should be cheap (a cache hit). This is a cost estimate, not a guarantee.'
      : 'The prompt cache has likely gone cold, so continuing the full conversation will re-prime the whole conversation and cost materially more. It is still allowed; a condensed new Session would be cheaper.',
  };
}

/**
 * Decide how a continuation triggered by `trigger` is offered on a Session with
 * the given `warmth`, as of `now` (issue #147 AC1–AC4). Pure and total.
 *
 * An automated trigger ({@link isAutomatedTrigger}) reuses the same Session
 * silently — no dialog, no cost gate (`silent-continue`). A human rejection
 * surfaces the choice (`offer-choice`): "continue full (same Session, with the
 * estimated cost)" vs "start a condensed new Session". The gate is the cost
 * estimate, not an elapsed-time clock, and both options are always present —
 * warmth informs the estimate, it never removes the full-continuation option.
 */
export function planSessionContinuation(
  trigger: ContinuationTrigger,
  warmth: SessionWarmthFacts,
  now: number,
): SessionContinuationPlan {
  if (isAutomatedTrigger(trigger)) {
    return { mode: 'silent-continue', trigger, sameSession: true };
  }
  return {
    mode: 'offer-choice',
    trigger: 'human-reject',
    continueFull: { session: 'same', conversation: 'full', estimate: estimateContinuationCost(warmth, now) },
    startCondensed: { session: 'new', conversation: 'condensed' },
  };
}

/**
 * Narrowing convenience: a whole {@link SessionRow} projected to the
 * {@link SessionWarmthFacts} the cost estimate reads. (A `SessionRow` is already
 * structurally assignable; this documents the exact projection for callers, the
 * same way `sessionFacts` does for the resume compatibility matrix.)
 */
export function sessionWarmthFacts(row: SessionRow): SessionWarmthFacts {
  return { estimatedWarmUntil: row.estimatedWarmUntil, lastActiveAt: row.lastActiveAt };
}
