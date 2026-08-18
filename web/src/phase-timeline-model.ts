import { RUN_PHASES, type RunEvent, type RunPhase } from './types.js';

export { RUN_PHASES };
export type { RunPhase };

/** Run states where nothing further will change (mirrors `Run['state']`'s
 * terminal members) — once here, a reached phase settles to `done` and
 * nothing is `current` any more. */
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled']);

const RUN_PHASE_SET: ReadonlySet<string> = new Set(RUN_PHASES);

/** One phase in the timeline, rendered by `PhaseTimeline`. */
export interface PhaseStep {
  phase: RunPhase;
  status: 'done' | 'current' | 'pending';
  /** The phase's first-recorded entry timestamp, or null when no phase
   * lifecycle event for it has landed yet (including the live current phase,
   * before its own event arrives). */
  at: number | null;
}

/**
 * Derive the Run's phase timeline from its recorded `{ type:'lifecycle',
 * payload:{ event:'phase', phase } }` events (issue #171). Pure and total:
 * never throws, and always returns one `PhaseStep` per `RUN_PHASES` entry in
 * order.
 *
 * A phase counts as *entered* when its first lifecycle event has landed, or
 * it is `currentPhase` (a live phase the client already knows about from
 * `Run.phase`, even before its own event arrives over the wire). An entered
 * phase is `current` when it is `currentPhase` and the run hasn't settled
 * yet; every other entered phase is `done`. A phase with neither an event
 * nor the current-phase flag is `pending` — this is a deliberately honest
 * read of the event log: a gap (a phase the run must logically have passed
 * through but whose own event never arrived) stays `pending` rather than
 * being inferred from phase order.
 *
 * Duplicate events for the same phase keep the first occurrence's `ts`
 * (array order, not `ts` order) — a later arrival never overwrites it. An
 * out-of-order event (a later phase's `ts` earlier than an earlier phase's)
 * is recorded at face value; this function doesn't reorder or reconcile
 * timestamps, only fold them per phase.
 */
export function phaseTimelineFromEvents(
  events: RunEvent[],
  currentPhase: RunPhase | null,
  runState: string,
): PhaseStep[] {
  const enteredAt = new Map<RunPhase, number>();
  for (const event of events) {
    if (event.type !== 'lifecycle') continue;
    const payload = event.payload as { event?: string; phase?: string } | null | undefined;
    if (payload?.event !== 'phase') continue;
    const phase = payload.phase;
    if (!phase || !RUN_PHASE_SET.has(phase)) continue;
    if (!enteredAt.has(phase as RunPhase)) enteredAt.set(phase as RunPhase, event.ts);
  }

  const settled = TERMINAL_RUN_STATES.has(runState);

  return RUN_PHASES.map((phase) => {
    const at = enteredAt.get(phase) ?? null;
    const entered = enteredAt.has(phase) || phase === currentPhase;
    const status: PhaseStep['status'] = !entered ? 'pending' : phase === currentPhase && !settled ? 'current' : 'done';
    return { phase, status, at };
  });
}
