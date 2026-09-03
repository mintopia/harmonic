// Explicit .js extensions: shared with the nodenext test project (Vite maps .js → .ts).
import type { TicketTimelineEvent } from './types.js';

/** Mirrors `MergeStepEvent` in `src/execution/merge-policy.ts`; one observable step of a single merge. */
export type MergeStepEvent =
  | { step: 'started'; baseBranch: string; taskBranch: string }
  | { step: 'conflict'; paths: string[] }
  | { step: 'resolve-turn'; turn: number; unmergedCount: number }
  | { step: 'post-check-skipped'; mergeOid: string }
  | { step: 'post-check-passed'; mergeOid: string }
  | { step: 'reverted'; mergeOid: string; revertOid: string }
  | { step: 'merged'; mergeOid: string }
  | { step: 'escalated'; reason: 'conflict' | 'post-merge-red'; message: string };

export type MergeStepTone = 'neutral' | 'running' | 'passed' | 'failed' | 'awaiting';

export interface MergeStepRow {
  key: string;
  label: string;
  /** Short one-line detail shown beside the label (a SHA, a count). */
  detail: string | null;
  /** Longer text revealed when the row is expanded — conflict paths, the full
   * escalation reason. `null` when the row has nothing more to show. */
  log: string | null;
  tone: MergeStepTone;
}

const shortOid = (oid: string): string => oid.slice(0, 7);

function rowFor(step: MergeStepEvent, index: number): MergeStepRow {
  const key = `${index}:${step.step}`;
  switch (step.step) {
    case 'started':
      return { key, label: 'Merge started', detail: `${step.taskBranch} into ${step.baseBranch}`, log: null, tone: 'running' };
    case 'conflict':
      return {
        key,
        label: step.paths.length === 1 ? 'Conflict in 1 file' : `Conflicts in ${step.paths.length} files`,
        detail: null,
        log: step.paths.join('\n'),
        tone: 'awaiting',
      };
    case 'resolve-turn':
      return {
        key,
        label: `Resolve turn ${step.turn}`,
        detail: step.unmergedCount === 1 ? '1 unmerged' : `${step.unmergedCount} unmerged`,
        log: null,
        tone: 'running',
      };
    case 'post-check-skipped':
      return { key, label: 'Post-merge check skipped', detail: 'no commands configured', log: null, tone: 'neutral' };
    case 'post-check-passed':
      return { key, label: 'Post-merge check passed', detail: shortOid(step.mergeOid), log: null, tone: 'passed' };
    case 'reverted':
      return {
        key,
        label: 'Reverted to keep base green',
        detail: shortOid(step.revertOid),
        log: `Merge ${shortOid(step.mergeOid)} reverted as ${shortOid(step.revertOid)}`,
        tone: 'failed',
      };
    case 'merged':
      return { key, label: 'Merged', detail: shortOid(step.mergeOid), log: null, tone: 'passed' };
    case 'escalated':
      return {
        key,
        label: step.reason === 'conflict' ? 'Escalated — merge conflict' : 'Escalated — post-merge check failed',
        detail: null,
        log: step.message,
        tone: 'awaiting',
      };
  }
}

/** Turn an ordered merge-step log into display rows. */
export function mergeStepRows(steps: readonly MergeStepEvent[]): MergeStepRow[] {
  return steps.map(rowFor);
}

/** Pull the ordered merge-step log a Task recorded out of its lifecycle timeline stream. */
export function mergeStepsFromTimeline(events: readonly TicketTimelineEvent[]): MergeStepEvent[] {
  const steps: MergeStepEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'lifecycle') continue;
    const payload = (event.data as { payload?: unknown } | null)?.payload as { event?: string; step?: MergeStepEvent } | undefined;
    if (payload?.event === 'merge-step' && payload.step) steps.push(payload.step);
  }
  return steps;
}
