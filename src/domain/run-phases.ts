/**
 * The Run phase machine (issue #114, reliability-design §0.2, locked).
 *
 * A Run advances through a small, fixed sequence of phases from the moment a
 * harness process is claimed to the moment the Run settles. The machine
 * branches exactly once — at `verifying` — depending on whether a human
 * review gate applies to this Run. Everything else about the sequence is
 * linear and total: no cycles, no dead ends other than `terminal`.
 *
 * This module is the phase machine as a pure function: no database, no
 * clock, no I/O — the same seam as `work-context-key.ts` and
 * `run-disposition.ts`, so the transition contract can be exhaustively
 * unit-tested in isolation and consumed by the drive loop / crash-recovery
 * sweep without either of them re-deriving the graph themselves.
 */

/**
 * Every phase a Run passes through, in traversal order. `terminal` is the
 * sink: there is no forward transition out of it. This array is the single
 * source of truth for phase order — `RunPhase` and the `PARKED_PHASES` guard
 * below are both derived from it (or from the same locked design), so the
 * sequence is never duplicated across the module.
 */
export const RUN_PHASES = ['executing', 'validating', 'verifying', 'review', 'landing', 'terminal'] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

/**
 * Whether a human review gate applies at the `verifying` branch.
 *
 * `'human'` — a native, human-gated Run: it passes through `review` and
 * waits there for an explicit accept/reject before `landing`.
 *
 * `'auto'` — a mirrored Run, or a native Run configured for auto-accept: it
 * skips `review` entirely and goes straight from `verifying` to `landing`.
 *
 * This is the ONE fork in the whole machine. Every other transition is fixed
 * regardless of gate, which is why `nextPhase` takes `gate` as a parameter
 * instead of the caller needing two separate tables.
 */
export type ReviewGate = 'human' | 'auto';

/**
 * The next phase after a clean forward transition, or `null` at `terminal`
 * (there is no phase after terminal — it is the sink of the machine).
 *
 * The branch lives entirely at `verifying`: a `'human'` gate routes through
 * `review` before `landing`; an `'auto'` gate routes directly to `landing`.
 * Every other phase has exactly one successor regardless of `gate`, so this
 * function is a plain switch — no recursion, no external state — and total
 * over every `(RunPhase, ReviewGate)` pair: it always returns, never throws.
 */
export function nextPhase(phase: RunPhase, gate: ReviewGate): RunPhase | null {
  switch (phase) {
    case 'executing':
      return 'validating';
    case 'validating':
      return 'verifying';
    case 'verifying':
      return gate === 'human' ? 'review' : 'landing';
    case 'review':
      return 'landing';
    case 'landing':
      return 'terminal';
    case 'terminal':
      return null;
  }
}

/**
 * The ordered list of phases a Run traverses from `from` (exclusive) up to
 * and including `to`, following `gate` at the `verifying` branch.
 *
 * The drive loop uses this to record every intermediate phase it passes
 * through in a single hop — e.g. a harness that goes straight from
 * `executing` to `verifying` internally still needs `validating` recorded
 * as a phase the Run was in, even though nothing paused there.
 *
 * Walks `nextPhase` starting at `from`, collecting each successor, and stops
 * as soon as `to` is produced (inclusive) or the walk runs out of forward
 * transitions (hits `null`, i.e. passes `terminal` without ever producing
 * `to`). If `to` is never reached this way — `to === from` (no forward
 * transition can produce the start phase again, since the machine is
 * acyclic), or `to` is unreachable under `gate` (e.g. an `'auto'` Run asked
 * for `review`, which its walk never visits) — the walk is discarded and `[]`
 * is returned rather than a partial path, so callers can treat a non-empty
 * result as "this hop is valid to record" without a separate reachability
 * check.
 *
 * The walk is capped at `RUN_PHASES.length` iterations as a defensive bound:
 * the chain is finite and acyclic by construction (`nextPhase` never revisits
 * a phase), so the cap is never actually hit, but it keeps this function
 * provably terminating rather than relying on that invariant silently.
 */
export function phasePath(from: RunPhase, to: RunPhase, gate: ReviewGate): RunPhase[] {
  const path: RunPhase[] = [];
  let current: RunPhase = from;
  for (let i = 0; i < RUN_PHASES.length; i++) {
    const next = nextPhase(current, gate);
    if (next === null) return []; // ran off the end (terminal) without finding `to`
    path.push(next);
    if (next === to) return path;
    current = next;
  }
  return []; // defensive: unreachable given the machine is finite/acyclic
}

/**
 * Phases where a `running` Run with NO live harness process is legitimately
 * parked awaiting an external actor, rather than orphaned by a crash.
 *
 * Boot-time crash recovery sweeps `running` Runs whose process is gone and
 * fails them as interrupted — that is correct for a Run sitting in
 * `executing`/`validating`/`verifying`/`landing`, where "no process" really
 * does mean the harness died mid-phase. It is WRONG for a Run parked in
 * `review`: that phase is *defined* by having no live process — it is
 * waiting on a human to accept or reject through the UI — so failing it on
 * restart would destroy a Run that was never broken. This is issue #114's
 * acceptance criterion that each phase survive a process restart: the
 * `PARKED_PHASES` set is how the crash-recovery sweep tells "parked, waiting
 * on an external actor" apart from "orphaned, waiting on nothing." Today
 * only `review` qualifies; if a future phase gains its own external wait
 * (e.g. a human landing-conflict gate), it is added here rather than special
 * -cased in the sweep.
 */
export const PARKED_PHASES = ['review'] as const;

/** True iff `phase` is one of `PARKED_PHASES`. `null`/`undefined` — a Run
 * with no phase recorded yet — is never parked. */
export function isParkedPhase(phase: RunPhase | null | undefined): boolean {
  if (phase == null) return false;
  return (PARKED_PHASES as readonly string[]).includes(phase);
}
