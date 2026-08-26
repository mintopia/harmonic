import { computeDisposition, type Disposition, type DispositionFact } from './run-disposition.js';

/**
 * The settle coordinator's projection contract (issue #113, reliability-design
 * §0.3). `computeDisposition` decides *which* ending signal wins by precedence;
 * this module decides *what terminal state that winner lands*.
 *
 * The terminal state is **not** a fixed function of the winning disposition
 * kind. A single `agent-finish/unresolved` can land the Task in
 * `done` (a landed ticket), leave it untouched (operator force-complete), or
 * re-queue it, depending on the Merge Fate and attempt budget resolved at
 * signal time.
 * So each ending signal records the concrete projection it intends in its
 * `run_fact` payload, and the coordinator replays the **winning** fact's
 * projection. Run/Task terminal state is thereby a projection of `run_facts`,
 * reconstructable from the log alone — never won by whoever wrote the Run row
 * first.
 */

/** The Run's terminal `runs.state` (never `running`). */
export type RunTerminalState = 'completed' | 'failed' | 'cancelled';

/**
 * What the coordinator does to the owning Task when the Run settles. `none`
 * leaves the Task untouched — the operator cancel/force-complete flow already
 * transitioned it through the Task service, so the coordinator must not fight
 * that. `done` lands the ticket, `ready` re-queues it (a transient fault the
 * next pick retries), `escalate` hands it to a human with the fact's reason.
 * Applied only while the Task is still `working` (or `escalated`, for the
 * operator Accept that lands from there); a racing cancel that already moved
 * it wins.
 */
export type SettleTaskAction = 'done' | 'escalate' | 'ready' | 'none';

/** The terminal projection a single ending signal intends, persisted verbatim
 * in the emitting `run_fact`'s payload. */
export interface SettleProjection {
  runState: RunTerminalState;
  taskAction: SettleTaskAction;
  reason: string | null;
}

/** A fact carrying the projection its emitting signal intended. Structurally a
 * {@link DispositionFact} (so it feeds `computeDisposition` directly) plus the
 * decoded payload. */
export interface CoordinatorFact extends DispositionFact {
  projection: SettleProjection;
}

/**
 * Collapse a Run's fact log to the terminal projection in force as of `cutoff`
 * (reliability-design §0.3). The winning disposition *kind* is chosen by fixed
 * precedence ({@link computeDisposition}); the projection returned is the
 * **earliest** fact of that kind at or before the cutoff — so close-together
 * signals resolve by precedence, and duplicate/late facts never change the
 * answer. Returns `null` when no fact is at or before the cutoff (the Run has
 * not ended as of that point).
 *
 * Pure and total: recomputing over the same `facts` + `cutoff` always yields the
 * same projection.
 */
export function projectSettle(facts: readonly CoordinatorFact[], cutoff: number): SettleProjection | null {
  const disposition: Disposition | null = computeDisposition(facts, cutoff);
  if (disposition === null) return null;
  let decisive: CoordinatorFact | null = null;
  for (const fact of facts) {
    if (fact.seq > cutoff) continue; // late: audit-only, never decisive
    if (fact.type !== disposition) continue;
    if (decisive === null || fact.seq < decisive.seq) decisive = fact;
  }
  return decisive ? decisive.projection : null;
}
