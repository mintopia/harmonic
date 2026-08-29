/**
 * The reliability slices of a Run, kept honest per ADR-0028: a Run that ended
 * in RunState `failed` is an *execution failure*; cancelled Runs are counted and
 * shown as their own slice, never as failures.
 */
export interface RunOutcome {
  /** The Run's terminal `state`. */
  state: string;
}

/** The failure-rate numerator's membership test (ADR-0028). */
export function isExecutionFailure({ state }: RunOutcome): boolean {
  return state === 'failed';
}

/** A failed Run's classification input (ADR-0001 #388 S-E): its Attempt's
 *  disposition-kind `reason` (the structured, low-cardinality category) and
 *  the free-text `runs.reason` fallback for a Run with no Attempt row. */
export interface FailedRun {
  /** `attempts.reason` for this Run's Attempt; null for pre-Attempt-timeline Runs. */
  attemptReason: string | null;
  /** `runs.reason` — free text, used only when no Attempt disposition exists. */
  runReason: string | null;
}

/**
 * The reason bucket a single failed Run falls into. Prefers the Attempt's
 * **disposition kind** (`failed`, `escalate`, `guardrail-trip`, `process-death`,
 * …) — the structured, low-cardinality category the settle coordinator wrote to
 * `attempts.reason`. `runs.reason` is deliberately *not* the primary key: it
 * carries unique free-text detail (each escalation message differs), so
 * bucketing by it would explode into singletons. It is the fallback only when a
 * Run recorded no Attempt disposition: `'interrupted'` folds into `process-death`
 * (its emitter, `RunStore.markInterrupted`), any other message into `failed`,
 * and a bare failure into `unknown` — never a fabricated category.
 */
export function failureReasonKey({ attemptReason, runReason }: FailedRun): string {
  if (attemptReason) return attemptReason;
  if (runReason === 'interrupted') return 'process-death';
  return runReason ? 'failed' : 'unknown';
}

/**
 * Count failed Runs by reason bucket. The caller passes only the execution
 * failures (see {@link isExecutionFailure}); cancelled and rejected Runs never
 * reach here. Returns a plain map keyed by {@link failureReasonKey}; ordering is
 * the presenter's job.
 */
export function failuresByReason(failures: FailedRun[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const key = failureReasonKey(f);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
