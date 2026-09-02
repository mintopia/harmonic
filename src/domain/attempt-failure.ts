/**
 * The reliability slices of an Attempt: an Attempt that ended `failed` (or
 * `escalated`) is an execution failure; cancelled Attempts are their own
 * slice, never failures.
 */
export interface AttemptOutcome {
  /** The Attempt's terminal `state`. */
  state: string;
}

/** The failure-rate numerator's membership test; `escalated` counts too. */
export function isExecutionFailure({ state }: AttemptOutcome): boolean {
  return state === 'failed' || state === 'escalated';
}

/** A failed Attempt's classification input: its disposition-kind `reason` and the free-text `detail` fallback. */
export interface FailedAttempt {
  /** `attempts.reason` — the structured disposition kind; null when none was recorded. */
  attemptReason: string | null;
  /** `attempts.detail` — free text, used only when no structured disposition exists. */
  detailReason: string | null;
}

/**
 * The reason bucket a single failed Attempt falls into: the disposition kind
 * when recorded; else `'interrupted'` folds into `process-death`, any other
 * detail into `failed`, and a bare failure into `unknown`.
 */
export function failureReasonKey({ attemptReason, detailReason }: FailedAttempt): string {
  if (attemptReason) return attemptReason;
  if (detailReason === 'interrupted') return 'process-death';
  return detailReason ? 'failed' : 'unknown';
}

/** Count failed Attempts by {@link failureReasonKey}. The caller passes only the execution failures. */
export function failuresByReason(failures: FailedAttempt[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const key = failureReasonKey(f);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
