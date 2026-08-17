/**
 * Terminal disposition of a Run (issue #112, reliability-design §0.1/§0.3).
 *
 * The coordination spine records every ending signal a Run emits as an
 * append-only `run_fact`. At each phase decision point — the **cutoff** — the
 * coordinator collapses the fact log to the single winning terminal disposition
 * by a fixed precedence. This module is that decision, as a pure function: no
 * database, no clock, no I/O — the same seam as `work-context-key.ts`, so the
 * precedence contract can be exhaustively unit-tested in isolation.
 *
 * Nothing calls this from the live settle path yet (that is the next unit); this
 * is the engine the rest of the spine consumes.
 */

/**
 * Every terminal disposition the coordinator can land, **highest precedence
 * first**. The reliability-design §0.3 locked ordering is:
 *
 *   operator-cancel > escalate > branch-violation > verify-fail >
 *   guardrail-trip > agent-finish/unresolved > process-death
 *
 * `failed` — today's generic execution-failure terminal (the pre-spine
 * `RUN_STATES` 'failed') — is not named in that locked list, so it is slotted
 * between `agent-finish/unresolved` and `process-death`: a reported failure is a
 * more informative ending signal than a bare process death (we have an error,
 * not merely absence), but less deliberate than an agent that ended its own turn.
 *
 * `branch-violation`, `verify-fail`, and `guardrail-trip` have **no emitter
 * yet** (#112 ships only today's fact types) but hold their precedence slot so
 * the branch-validation / verification / guardrail units drop in later without
 * renumbering. This array is the single source of truth for precedence and the
 * one place a new disposition is ranked — extending the set never touches
 * `computeDisposition`.
 */
export const DISPOSITION_PRECEDENCE = [
  'operator-cancel',
  'escalate',
  'branch-violation',
  'verify-fail',
  'guardrail-trip',
  'agent-finish/unresolved',
  'failed',
  'process-death',
] as const;

export type Disposition = (typeof DISPOSITION_PRECEDENCE)[number];

/**
 * The minimal shape `computeDisposition` needs from a fact: its position in the
 * Run's monotonic log (`seq`) and its kind (`type`). A persisted `RunFactRow`
 * satisfies this structurally, so callers pass the store's rows directly; the
 * function itself stays free of any database type.
 */
export interface DispositionFact {
  seq: number;
  type: Disposition;
}

/** Precedence rank of each disposition — lower wins. Built once from the table. */
const RANK: ReadonlyMap<Disposition, number> = new Map(
  DISPOSITION_PRECEDENCE.map((disposition, index) => [disposition, index]),
);

/**
 * Collapse a Run's fact log to its single winning terminal disposition as of
 * `cutoff` (reliability-design §0.3).
 *
 * Only facts **at or before** the cutoff decide: `seq <= cutoff`. A fact with
 * `seq > cutoff` is *late* — it remains an audit event in the log but cannot
 * alter the disposition (the code has already reached its decision point). Among
 * the deciding facts, the one whose kind has the highest precedence wins; ties
 * on kind are irrelevant because the result is the kind, not the fact — so
 * duplicate facts of the winning kind, and any input ordering, all yield the
 * same answer. Returns `null` when no fact is at or before the cutoff (the Run
 * has not ended as of that point).
 *
 * Pure and total: recomputing over the same `facts` + `cutoff` always yields the
 * same disposition.
 */
export function computeDisposition(facts: readonly DispositionFact[], cutoff: number): Disposition | null {
  let winner: Disposition | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const fact of facts) {
    if (fact.seq > cutoff) continue; // late: audit-only, never decisive
    // A type absent from the precedence table sinks to the bottom rather than
    // throwing: this is what keeps the fact-type set "open for extension without
    // touching the coordinator contract" — a Run row persisted by a newer unit
    // whose disposition this build doesn't yet rank still degrades gracefully
    // (it can only lose to a known disposition, never silently outrank one).
    const rank = RANK.get(fact.type) ?? Number.POSITIVE_INFINITY;
    if (rank < bestRank) {
      bestRank = rank;
      winner = fact.type;
    }
  }
  return winner;
}
