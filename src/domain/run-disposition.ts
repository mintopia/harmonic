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
 * `operator-accept` (issue #191) is slotted just below `operator-cancel` and
 * just above `escalate`: an operator's explicit Accept of an escalated-then-
 * adopted-for-review Run is a deliberate human disposition that must outrank
 * the automatic `escalate` fact already sitting on that Run's log (otherwise
 * the accept's irreversible land runs, but the disposition still collapses
 * back to the earlier escalate — a split-brain between the merge that
 * happened and the bookkeeping that says it didn't). An operator cancel still
 * wins over an accept, though: cancel-vs-accept is resolved the same way every
 * other cancel race is (`landing-coordinator.ts`'s PONC) — safety wins, but
 * only up to the point of no return; a cancel fact appended *after* the land's
 * PONC cutoff is late and cannot un-land a Run the accept has already
 * committed.
 */
export const DISPOSITION_PRECEDENCE = [
  'operator-cancel',
  'operator-accept',
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
 *
 * `type` is a free `string`, not `Disposition`: the fact-type set is open for
 * extension (schema `RUN_FACT_TYPES`), and some facts — e.g. `run-start-state`
 * (issue #149) — are recorded on the same log but are *not* terminal
 * dispositions. `computeDisposition` sinks any unranked kind to the bottom, so a
 * non-disposition fact can never decide the outcome.
 */
export interface DispositionFact {
  seq: number;
  type: string;
}

/** Precedence rank of each disposition — lower wins. Built once from the table. */
const RANK: ReadonlyMap<string, number> = new Map(
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
      // A finite rank means `fact.type` is a key of RANK, i.e. a Disposition;
      // the cast recovers that (the input `type` is a free string).
      winner = fact.type as Disposition;
    }
  }
  return winner;
}
