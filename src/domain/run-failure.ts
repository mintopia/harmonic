import { computeDisposition, type DispositionFact } from './run-disposition.js';

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
