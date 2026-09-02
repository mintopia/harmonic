// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).
import type { AttemptSummary, Step } from './types.js';

/** The state-signal family a run's dot/word draws from (DESIGN.md § Signal
 * Rule); `neutral` is the un-coloured register (cancelled). */
export type AttemptDot = 'running' | 'fail' | 'merged' | 'neutral';

/** How a single run reads at a glance: its disposition word, the signal dot
 * that word rides, and whether the dot pulses (only live, unparked work). */
export interface AttemptDisplay {
  word: string;
  dot: AttemptDot;
  pulse: boolean;
}

/**
 * A run's disposition, folded from its terminal state first and only then its
 * live Step: a still-`running` run reads by whichever Step is currently
 * running in its owning Attempt.
 * `steps` is the matching Attempt's timeline (by `run.attempt` ===
 * `Attempt.number`); pass `[]` when it isn't loaded (e.g. a historical run
 * the gate bar never actually renders `running` for). Pure.
 */
export function attemptDisplay(run: AttemptSummary, steps: readonly Step[] = []): AttemptDisplay {
  switch (run.state) {
    case 'failed':
      return { word: 'failed', dot: 'fail', pulse: false };
    case 'cancelled':
      return { word: 'cancelled', dot: 'neutral', pulse: false };
    case 'completed':
      return { word: 'merged', dot: 'merged', pulse: false };
    case 'running': {
      const running = steps.find((step) => step.state === 'running');
      const word = running?.type ?? 'running';
      return { word, dot: 'running', pulse: true };
    }
  }
}

/** A changed file the rail can link into the worktree-wide Changes view.
 *
 * `git diff --numstat` does not include Git's add/modify status, so the current
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
 * Parse the per-file lines from `git diff --numstat`, each
 * `additions<TAB>deletions<TAB>path`. Counts are exact line totals — unlike the
 * `--stat` graph, whose `+`/`-` bar is a width-capped histogram that collapses
 * to a `+1`/`-1` fiction on small diffs. A binary file reports `-` for both
 * counts, which reads as 0 changed lines.
 */
export function changedFilesFromNumstat(numstat: string | null): ChangedFile[] {
  if (!numstat) return [];
  const files: ChangedFile[] = [];
  for (const line of numstat.split('\n')) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!match) continue;
    const additions = match[1];
    const deletions = match[2];
    const path = match[3];
    if (additions === undefined || deletions === undefined || path === undefined) continue;
    files.push({
      path,
      kind: 'M',
      additions: additions === '-' ? 0 : Number(additions),
      deletions: deletions === '-' ? 0 : Number(deletions),
    });
  }
  return files;
}

/** The current run's id: the highest attempt. `null` for a task with no runs.
 * Runs need not arrive sorted — picked by max `attempt`, not array position. */
export function currentAttemptId(runs: AttemptSummary[]): number | null {
  let current: AttemptSummary | null = null;
  for (const run of runs) {
    if (!current || run.number > current.number) current = run;
  }
  return current?.id ?? null;
}
