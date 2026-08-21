import { computeDisposition, type DispositionFact } from './run-disposition.js';

/**
 * The reliability slices of a Run, kept honest per ADR-0028. A Run that ended in
 * RunState `failed` is only an *execution failure* when it was not review-rejected
 * — a rejection settles the Run to `state:'failed'` **and** `review:'rejected'`
 * together (`reject()` in `domain/review.ts`), so filtering by state alone folds
 * reviewer judgment calls into the failure rate. Cancelled and rejected Runs are
 * counted and shown as their own slices, never as failures.
 */
export interface RunOutcome {
  /** The Run's terminal `state`. */
  state: string;
  /** The Run's review decision: 'accepted' | 'rejected' | null. */
  review: string | null;
}

/** True for a genuine execution failure (ADR-0028): `state:'failed'` that was
 *  not review-rejected. This is the failure-rate numerator's membership test. */
export function isExecutionFailure({ state, review }: RunOutcome): boolean {
  return state === 'failed' && review !== 'rejected';
}

/** True for a review-rejected Run — shown as its own slice, never a failure. */
export function isReviewRejected({ review }: RunOutcome): boolean {
  return review === 'rejected';
}

/** A failed Run's classification input: its `run_facts` (the terminal
 *  disposition is derived from them) and the free-text `runs.reason` fallback. */
export interface FailedRun {
  /** This Run's disposition facts (`type` + `seq`); empty for pre-spine Runs. */
  facts: DispositionFact[];
  /** `runs.reason` — free text, used only when no disposition fact exists. */
  reason: string | null;
}

/**
 * The reason bucket a single failed Run falls into. Prefers the Run's **winning
 * terminal disposition** (`failed`, `escalate`, `guardrail-trip`, `process-death`,
 * …) — the structured, low-cardinality category, chosen by the same precedence
 * the settle coordinator uses. `runs.reason` is deliberately *not* the primary
 * key: it carries unique free-text detail (each escalation message differs), so
 * bucketing by it would explode into singletons. It is the fallback only when a
 * Run recorded no disposition fact: `'interrupted'` folds into `process-death`
 * (its emitter), any other message into `failed`, and a bare failure into
 * `unknown` — never a fabricated category.
 */
export function failureReasonKey({ facts, reason }: FailedRun): string {
  const maxSeq = facts.reduce((m, f) => (f.seq > m ? f.seq : m), 0);
  const disposition = facts.length > 0 ? computeDisposition(facts, maxSeq) : null;
  if (disposition !== null) return disposition;
  if (reason === 'interrupted') return 'process-death';
  return reason ? 'failed' : 'unknown';
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
