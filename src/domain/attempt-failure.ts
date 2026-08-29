/**
 * The reliability slices of an Attempt, kept honest per ADR-0028: an Attempt
 * that ended `failed` (or `escalated`) is an *execution failure*; cancelled
 * Attempts are counted and shown as their own slice, never as failures.
 */
export interface AttemptOutcome {
  /** The Attempt's terminal `state`. */
  state: string;
}

/** The failure-rate numerator's membership test (ADR-0028). `escalated` counts
 * too: it is the same failure bucket, distinguished only so the human hedge is
 * visible as its own state. */
export function isExecutionFailure({ state }: AttemptOutcome): boolean {
  return state === 'failed' || state === 'escalated';
}

/** A failed Attempt's classification input (ADR-0001): its
 *  disposition-kind `reason` (the structured, low-cardinality category) and
 *  the free-text `detail` fallback for a row with no structured disposition. */
export interface FailedAttempt {
  /** `attempts.reason` — the structured disposition kind; null when none was recorded. */
  attemptReason: string | null;
  /** `attempts.detail` — free text, used only when no structured disposition exists. */
  detailReason: string | null;
}

/**
 * The reason bucket a single failed Attempt falls into. Prefers the
 * **disposition kind** (`failed`, `escalate`, `guardrail-trip`, `process-death`,
 * …) — the structured, low-cardinality category the settle coordinator wrote to
 * `attempts.reason`. The free-text detail is deliberately *not* the primary
 * key: it carries unique text (each escalation message differs), so bucketing
 * by it would explode into singletons. It is the fallback only when no
 * structured disposition was recorded: `'interrupted'` folds into
 * `process-death`, any other message into `failed`, and a bare failure into
 * `unknown` — never a fabricated category.
 */
export function failureReasonKey({ attemptReason, detailReason }: FailedAttempt): string {
  if (attemptReason) return attemptReason;
  if (detailReason === 'interrupted') return 'process-death';
  return detailReason ? 'failed' : 'unknown';
}

/**
 * Count failed Attempts by reason bucket. The caller passes only the execution
 * failures (see {@link isExecutionFailure}); cancelled Attempts never reach
 * here. Returns a plain map keyed by {@link failureReasonKey}; ordering is the
 * presenter's job.
 */
export function failuresByReason(failures: FailedAttempt[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const key = failureReasonKey(f);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
