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
  status: 'done' | 'current' | 'gap' | 'pending';
  /** The phase's first-recorded entry timestamp, or null when no phase
   * lifecycle event for it has merged yet (including the live current phase,
   * before its own event arrives). */
  at: number | null;
  /** Time spent in this phase: the nearest later `RUN_PHASES` entry's `at`
   * minus this phase's own `at`. Null when this phase has no `at` (never
   * entered, or entered only via `currentPhase` with no event yet), or when
   * no later phase has merged an `at` yet (open-ended — still the last known
   * phase, whether that's genuinely running or just unreported). */
  durationMs: number | null;
}

/**
 * Derive the Run's phase timeline from its recorded `{ type:'lifecycle',
 * payload:{ event:'phase', phase } }` events (issue #171, #176). Pure and
 * total: never throws, and always returns one `PhaseStep` per `RUN_PHASES`
 * entry in order.
 *
 * A phase counts as *entered* when its first lifecycle event has merged, or
 * it is `currentPhase` (a live phase the client already knows about from
 * `Run.phase`, even before its own event arrives over the wire). An entered
 * phase is `current` when it is `currentPhase` and the run hasn't settled
 * yet; every other entered phase is `done`.
 *
 * A phase that was never entered reads one of two ways, and the difference
 * matters to the operator: if some *later* `RUN_PHASES` entry has been
 * entered, the run must logically have passed through this one too, but its
 * own event never arrived — that's a `gap` (a data-honesty note, not a
 * failure). If nothing later has been entered either, the run genuinely
 * hasn't reached it yet, so it stays `pending`.
 *
 * Duplicate events for the same phase keep the first occurrence's `ts`
 * (array order, not `ts` order) — a later arrival never overwrites it. An
 * out-of-order event (a later phase's `ts` earlier than an earlier phase's)
 * is recorded at face value; this function doesn't reorder or reconcile
 * timestamps, only fold them per phase — which is also why `durationMs` is
 * computed from `RUN_PHASES` order, not by sorting `at` values.
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
  const entered = RUN_PHASES.map((phase) => enteredAt.has(phase) || phase === currentPhase);

  // Two single backward walks, each a cascade off the previous index: whether
  // *any* later phase was entered (decides gap vs pending), and the nearest
  // later `at` that merged (decides durationMs's open end).
  const laterEntered: boolean[] = new Array(RUN_PHASES.length).fill(false);
  const nextAt: (number | null)[] = new Array(RUN_PHASES.length).fill(null);
  for (let i = RUN_PHASES.length - 2; i >= 0; i--) {
    laterEntered[i] = entered[i + 1]! || laterEntered[i + 1]!;
    nextAt[i] = enteredAt.get(RUN_PHASES[i + 1]!) ?? nextAt[i + 1]!;
  }

  return RUN_PHASES.map((phase, i) => {
    const at = enteredAt.get(phase) ?? null;
    const status: PhaseStep['status'] = entered[i]
      ? phase === currentPhase && !settled
        ? 'current'
        : 'done'
      : laterEntered[i]
        ? 'gap'
        : 'pending';
    // A negative span only arises from out-of-order phase timestamps (the fold
    // records `at` at face value, never reorders) — not a real duration, so it
    // reports as `null` (unknown) rather than a nonsensical negative (issue #176).
    const raw = at != null && nextAt[i] != null ? nextAt[i]! - at : null;
    const durationMs = raw != null && raw >= 0 ? raw : null;
    return { phase, status, at, durationMs };
  });
}

/** Compact ms → "1m 20s" / "12s" for a phase's duration span (issue #176).
 * Lives in the model (not the component) so it's unit-testable, mirroring
 * `board-model`'s `fmtElapsed` seam. Input is always a settled non-negative
 * span (`PhaseStep.durationMs`); it doesn't tick. */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
