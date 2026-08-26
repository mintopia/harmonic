// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { Run } from './types.js';

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

/** A changed file the rail can link into the worktree-wide Changes view.
 *
 * `git diff --stat` does not include Git's add/modify status, so the current
 * endpoint can only truthfully render the neutral `M` badge. Keeping that
 * limitation in this view model makes the eventual richer diff response a
 * single-boundary upgrade rather than an inference in the component.
 */
export interface ChangedFile {
  path: string;
  kind: 'M';
  additions: number;
  deletions: number;
}

/**
 * Parse the per-file lines from `git diff --stat`. The final summary line has
 * no pipe and is intentionally ignored. Git's graph comprises `+` / `-`
 * characters, which give the compact per-file addition/deletion counts the
 * rail needs without presenting the aggregate summary as a selectable file.
 */
export function changedFilesFromStat(stat: string | null): ChangedFile[] {
  if (!stat) return [];
  const files: ChangedFile[] = [];
  for (const line of stat.split('\n')) {
    const match = /^\s*(.+?)\s+\|\s+\d+\s+([+-]+)\s*$/.exec(line);
    if (!match) continue;
    const path = match[1];
    const graph = match[2];
    if (path === undefined || graph === undefined) continue;
    files.push({
      path,
      kind: 'M',
      additions: [...graph].filter((mark) => mark === '+').length,
      deletions: [...graph].filter((mark) => mark === '-').length,
    });
  }
  return files;
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
