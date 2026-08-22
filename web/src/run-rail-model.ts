// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Run } from './types.js';
import { formatCost } from './cost.js';

/**
 * Pure view-model helpers behind the Ticket page's run rail (issue #183, part
 * of #179 — the Deck redesign). The rail switches per-run detail, so every
 * chip needs a single derived "how this run reads" — a state word, a
 * state-signal dot, and whether that dot pulses (work in flight). That
 * derivation lives here, once, so `RunRail` and the read-only result bar
 * (`ticket-gate-model.ts`) never re-derive a run's disposition independently
 * (the same pure-formatter house style as `task-actions-model.ts` /
 * `verification-attempts-model.ts`).
 */

/** The state-signal family a run's dot/word draws from (DESIGN.md § Signal
 * Rule). `review` is the indigo gate colour (a run parked at the human gate);
 * `neutral` is the un-coloured register (cancelled). */
export type RunDot = 'running' | 'fail' | 'merged' | 'review' | 'neutral';

/** How a single run reads at a glance: its disposition word, the signal dot
 * that word rides, and whether the dot pulses (only live, unparked work). */
export interface RunDisplay {
  word: string;
  dot: RunDot;
  pulse: boolean;
}

/**
 * A run's disposition, folded from its terminal fate first (review verdict,
 * then run state) and only then its live phase. Order matters: an accepted or
 * rejected run is settled regardless of how its phase machine ended, so the
 * review verb wins; a still-`running` run reads by its phase, and a run parked
 * at the human gate (`phase:'review'`) reads "awaiting" in the cobalt gate
 * colour rather than as amber work-in-flight. Pure.
 */
export function runDisplay(run: Run): RunDisplay {
  if (run.review === 'accepted') return { word: 'merged', dot: 'merged', pulse: false };
  if (run.review === 'rejected') return { word: 'rejected', dot: 'fail', pulse: false };
  switch (run.state) {
    case 'failed':
      return { word: 'failed', dot: 'fail', pulse: false };
    case 'cancelled':
      return { word: 'cancelled', dot: 'neutral', pulse: false };
    case 'completed':
      // Merged/settled without an explicit review flag (e.g. an afk auto-merge
      // or an operator Complete) — reads as done, not amber.
      return { word: 'merged', dot: 'merged', pulse: false };
    case 'running':
      if (run.phase === 'review') return { word: 'awaiting', dot: 'review', pulse: false };
      // executing | validating | verifying carry their phase word; `landing`
      // displays as the operator-facing "merging" label.
      // a pre-feature run with no phase reads the generic 'running'.
      const word = run.phase === 'landing' ? 'merging' : run.phase && run.phase !== 'terminal' ? run.phase : 'running';
      return { word, dot: 'running', pulse: true };
  }
}

/** One run's chip on the rail. `isCurrent` is the latest attempt — the only
 * run the review gate can act on (`ticket-gate-model.ts`). */
export interface RunChip {
  runId: number;
  attempt: number;
  label: string;
  dot: RunDot;
  pulse: boolean;
  stateWord: string;
  cost: string | null;
  duration: string | null;
  isCurrent: boolean;
}

/** The current run's id: the highest attempt. `null` for a task with no runs.
 * Runs need not arrive sorted — picked by max `attempt`, not array position. */
export function currentRunId(runs: Run[]): number | null {
  let current: Run | null = null;
  for (const run of runs) {
    if (!current || run.attempt > current.attempt) current = run;
  }
  return current?.id ?? null;
}

/** A run's wall-clock as a compact `Ns` / `Nm Ss`, or null while it is still
 * in flight (no `finishedAt`). Seconds only under a minute; minutes+seconds
 * above. Pure — clamps a negative delta (clock skew) to 0. */
export function formatRunDuration(run: Run): string | null {
  if (run.finishedAt === null) return null;
  const secs = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * The rail's chips, one per run, sorted by attempt ascending (Run 1 → Run N,
 * left to right). Each chip carries its own derived disposition ({@link
 * runDisplay}), formatted cost, and duration. Pure: does not mutate `runs`.
 */
export function runRailChips(runs: Run[]): RunChip[] {
  const current = currentRunId(runs);
  return [...runs]
    .sort((a, b) => a.attempt - b.attempt)
    .map((run) => {
      const d = runDisplay(run);
      return {
        runId: run.id,
        attempt: run.attempt,
        label: `Run ${run.attempt}`,
        dot: d.dot,
        pulse: d.pulse,
        stateWord: d.word,
        cost: formatCost(run.cost),
        duration: formatRunDuration(run),
        isCurrent: run.id === current,
      };
    });
}

/**
 * The rail's session-continuation note: when the current run resumed an
 * earlier run's Session (same non-null `sessionId`), the human-legible "Run X
 * continued Run Y's session" line under the rail (the prototype's warm-session
 * hint). `null` when the current run started its own Session, there are fewer
 * than two runs, or the current run has no session id yet. It names the most
 * recent earlier run that shares the id — the run whose conversation was
 * carried forward. Pure.
 */
export function continuationNote(runs: Run[]): string | null {
  const currentId = currentRunId(runs);
  if (currentId === null) return null;
  const current = runs.find((r) => r.id === currentId)!;
  if (current.sessionId === null) return null;
  let source: Run | null = null;
  for (const run of runs) {
    if (run.id === current.id) continue;
    if (run.attempt >= current.attempt) continue;
    if (run.sessionId !== current.sessionId) continue;
    if (!source || run.attempt > source.attempt) source = run;
  }
  if (!source) return null;
  return `Run ${current.attempt} continued Run ${source.attempt}’s session`;
}
