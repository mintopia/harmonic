/**
 * The Run phase machine (issue #114, reliability-design §0.2; review gate
 * removed by ADR-0041). A Run advances through a small, fixed, linear sequence
 * of phases from the moment a harness process is claimed to the moment the Run
 * settles: no cycles, no forks, no dead ends other than `terminal`.
 *
 * Pure: no database, no clock, no I/O — the same seam as `work-context-key.ts`
 * and `run-disposition.ts`, so the transition contract is exhaustively
 * unit-testable and the drive loop / crash-recovery sweep never re-derive it.
 */

/** Every phase a Run passes through, in traversal order; `terminal` is the sink. */
export const RUN_PHASES = ['executing', 'validating', 'verifying', 'landing', 'terminal'] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/** The next phase after a clean forward transition, or `null` at `terminal`. */
export function nextPhase(phase: RunPhase): RunPhase | null {
  const index = RUN_PHASES.indexOf(phase);
  return index === RUN_PHASES.length - 1 ? null : RUN_PHASES[index + 1]!;
}

/**
 * The ordered phases a Run traverses from `from` (exclusive) up to and
 * including `to`. The drive loop records every intermediate phase it passes
 * through in a single hop — a harness that goes straight from `executing` to
 * `verifying` still gets `validating` recorded. `[]` when `to` is not ahead of
 * `from`, so a non-empty result means "this hop is valid to record".
 */
export function phasePath(from: RunPhase, to: RunPhase): RunPhase[] {
  const start = RUN_PHASES.indexOf(from);
  const end = RUN_PHASES.indexOf(to);
  return end > start ? RUN_PHASES.slice(start + 1, end + 1) : [];
}
