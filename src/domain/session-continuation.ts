import type { AttemptRow, SessionRow } from '../db/schema.js';

export type DeterministicContinuation = {
  path: 'continued-session' | 'new-session-condensed';
  reason: 'continued-within-limits' | 'context-tokens' | 'session-cold' | 'missing-context-tokens';
  /** The session's context-window occupancy in raw tokens (the last turn's
   * input-side footprint), or null when it can't be known. */
  contextTokens: number | null;
  /** Reuse the warm Session while occupancy stays below this many tokens; at or
   * above it, start a condensed new Session. A raw token count, not a fraction. */
  contextReuseTokenLimit: number;
  lastActiveAt: number;
  lastActiveAgeMs: number;
  warmWindowMs: number | null;
};

/** Deterministically choose Attempt N+1's Session. Boundary values start fresh. */
export function decideAttemptContinuation(input: {
  cacheWarmSeconds: number;
  contextTokens: number | null;
  lastActiveAt: number;
  contextReuseTokenLimit: number;
  now: number;
}): DeterministicContinuation {
  const warmWindowMs = input.cacheWarmSeconds * 1000;
  const lastActiveAgeMs = input.now - input.lastActiveAt;
  const facts = { contextTokens: input.contextTokens, contextReuseTokenLimit: input.contextReuseTokenLimit, lastActiveAt: input.lastActiveAt, lastActiveAgeMs, warmWindowMs };
  if (input.contextTokens === null) return { path: 'new-session-condensed', reason: 'missing-context-tokens', ...facts };
  if (input.contextTokens >= input.contextReuseTokenLimit) return { path: 'new-session-condensed', reason: 'context-tokens', ...facts };
  if (lastActiveAgeMs >= warmWindowMs) return { path: 'new-session-condensed', reason: 'session-cold', ...facts };
  return { path: 'continued-session', reason: 'continued-within-limits', ...facts };
}

/**
 * What prompted the continuation. Two are automated (they reuse the Session
 * silently); manual intervention surfaces the cost-gated choice.
 */
export const CONTINUATION_TRIGGERS = [
  /** Harmonic re-ran the work itself after a transient/interrupted failure. */
  'automatic-retry',
  /** The verify-agent rejected the result — an automated critic that fires
   * while the Session is still warm. */
  'verify-reject',
  /** An operator resumes paused or escalated work, or retries it with
   * guidance. This surfaces the "continue full vs condensed new" choice. */
  'manual-resume',
] as const;
export type ContinuationTrigger = (typeof CONTINUATION_TRIGGERS)[number];

/** The triggers Harmonic fires without a human in the loop; they reuse the warm Session silently. */
export const AUTOMATED_CONTINUATION_TRIGGERS = ['automatic-retry', 'verify-reject'] as const satisfies readonly ContinuationTrigger[];
export type AutomatedContinuationTrigger = (typeof AUTOMATED_CONTINUATION_TRIGGERS)[number];

const AUTOMATED_TRIGGER_SET: ReadonlySet<ContinuationTrigger> = new Set(AUTOMATED_CONTINUATION_TRIGGERS);

/** Whether `trigger` is one Harmonic fires automatically (silent warm reuse). */
export function isAutomatedTrigger(trigger: ContinuationTrigger): trigger is AutomatedContinuationTrigger {
  return AUTOMATED_TRIGGER_SET.has(trigger);
}

/** The facet of a stored Session the cost estimate reads. A whole {@link SessionRow} is structurally assignable. */
export interface SessionWarmthFacts {
  /** Estimated epoch-ms at which the provider prompt cache goes cold, or `null`
   * when the harness has no known warm window. */
  estimatedWarmUntil: number | null;
  /** Epoch-ms of the Session's last dispatch/prompt activity. */
  lastActiveAt: number;
}

/**
 * How warm the Session's prompt cache is likely to be — the cost band a full
 * continuation faces.
 * - `warm`: `now` is within the estimated warm window.
 * - `cold`: the window has lapsed — a full continuation re-primes the whole
 *   conversation (still allowed).
 * - `unknown`: the harness has no known warm window.
 */
export type WarmthBand = 'warm' | 'cold' | 'unknown';

/**
 * The cost signal shown alongside the "continue full" option — a read-only
 * estimate, never a gate. `band` is the headline; the raw deltas are carried so
 * the UI can render its own copy.
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
 * The cost signal shown alongside the "start condensed" option. A condensed
 * re-attempt spawns a fresh Session re-primed from a compact summary, so its
 * cost is expressed relative to the full continuation: the two paths trade
 * places on which is cheaper as the source warmth changes.
 */
export interface CondensedContinuationEstimate {
  /** The condensed path's cost band, relative to continuing full:
   * - `cold`: the source Session is warm, so continuing full is a live cache hit;
   *   condensed is the pricier of the two.
   * - `warm`: the source Session is cold or has no known warm window, so a fresh
   *   Session re-priming only a summary is the cheaper path.
   * Never `unknown`: a condensed re-prime is always a bounded cost. */
  band: WarmthBand;
  /** A human-legible one-liner for the dialog — a cost signal, never a guarantee. */
  note: string;
}

/**
 * The plan for how a continuation is offered.
 * - `silent-continue`: an automated trigger — reuse the same Session with no
 *   operator dialog. `sameSession` is always true; there is no cost gate.
 * - `offer-choice`: a human rejection — surface the two options. `continueFull`
 *   continues the **same** Session (full conversation) and carries the cost
 *   {@link ContinuationCostEstimate}; `startCondensed` starts a **new** Session
 *   seeded with a condensed summary and carries its own relative
 *   {@link CondensedContinuationEstimate}. Both are always available — warmth
 *   informs the estimates, it never removes an option.
 */
export type SessionContinuationPlan =
  | { mode: 'silent-continue'; trigger: AutomatedContinuationTrigger; sameSession: true }
  | {
      mode: 'offer-choice';
      trigger: 'manual-resume';
      continueFull: { session: 'same'; conversation: 'full'; estimate: ContinuationCostEstimate };
      startCondensed: { session: 'new'; conversation: 'condensed'; estimate: CondensedContinuationEstimate };
    };

/**
 * Estimate the cost of continuing the full conversation in `warmth`'s Session
 * as of `now`. `cold` and `unknown` both still permit a full continuation; they
 * only raise the cost the caller shows.
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
 * Estimate the cost of starting a condensed re-attempt (a fresh Session
 * re-primed from a compact summary) as of `now`, relative to continuing full:
 * `cold` when the source Session is warm (full is a live cache hit, condensed
 * is the pricier path), `warm` when the source is cold or has no known window.
 */
export function estimateCondensedContinuationCost(warmth: SessionWarmthFacts, now: number): CondensedContinuationEstimate {
  const full = estimateContinuationCost(warmth, now);
  if (full.band === 'warm') {
    return {
      band: 'cold',
      note: 'The prompt cache is likely still warm, so continuing the full conversation is a cache hit and probably cheaper; a condensed re-attempt re-primes a summary from cold, so it is the pricier of the two here — though still a small, bounded cost.',
    };
  }
  return {
    band: 'warm',
    note: full.warmthKnown
      ? 'The prompt cache has likely gone cold, so a fresh Session that re-primes only a compact summary is cheaper than replaying the whole cold conversation.'
      : 'A fresh Session re-primes only a compact summary — fewer tokens than replaying the whole conversation — so it is the cheaper, more predictable path.',
  };
}

/**
 * Decide how a continuation triggered by `trigger` is offered on a Session with
 * the given `warmth`, as of `now`. An automated trigger reuses the same Session
 * silently (`silent-continue`). A human rejection surfaces the choice
 * (`offer-choice`); both options are always present — warmth informs the
 * estimate, it never removes an option.
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
    trigger: 'manual-resume',
    continueFull: { session: 'same', conversation: 'full', estimate: estimateContinuationCost(warmth, now) },
    startCondensed: { session: 'new', conversation: 'condensed', estimate: estimateCondensedContinuationCost(warmth, now) },
  };
}

/** A whole {@link SessionRow} projected to the {@link SessionWarmthFacts} the cost estimate reads. */
export function sessionWarmthFacts(row: SessionRow, cacheWarmSeconds: number): SessionWarmthFacts {
  return { estimatedWarmUntil: row.lastActiveAt + cacheWarmSeconds * 1000, lastActiveAt: row.lastActiveAt };
}

/**
 * Preview the manual-resume continuation choice for a Task before the operator
 * resumes it, so the resume dialog can show both options. Looks at the newest
 * Attempt (`runsForTask` is newest-last) that holds a live Session and projects
 * the `manual-resume` plan against its warmth. Returns the `offer-choice` plan,
 * or `null` when no Attempt ever bound a Session or it has since been swept.
 */
export function previewManualResumeContinuation(
  runsForTask: readonly AttemptRow[],
  getSession: (sessionRowId: number) => SessionRow | null,
  cacheWarmSeconds: number,
  now: number,
): Extract<SessionContinuationPlan, { mode: 'offer-choice' }> | null {
  for (let i = runsForTask.length - 1; i >= 0; i--) {
    const run = runsForTask[i]!;
    if (run.sessionRowId === null) continue;
    const session = getSession(run.sessionRowId);
    if (!session) continue;
    const plan = planSessionContinuation('manual-resume', sessionWarmthFacts(session, cacheWarmSeconds), now);
    return plan as Extract<SessionContinuationPlan, { mode: 'offer-choice' }>;
  }
  return null;
}
