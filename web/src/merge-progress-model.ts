/** Mirrors `MergeStepEvent` in `src/execution/merge-policy.ts`; one observable step of a single merge. */
export type MergeStepEvent =
  | { step: 'started'; baseBranch: string; taskBranch: string }
  | { step: 'conflict'; paths: string[] }
  | { step: 'resolve-turn'; turn: number; unmergedCount: number }
  | { step: 'post-check-skipped'; mergeOid: string }
  | { step: 'post-check-passed'; mergeOid: string }
  | { step: 'reverted'; mergeOid: string; revertOid: string }
  | { step: 'merged'; mergeOid: string }
  | { step: 'checkout-synced'; mergeOid: string; mergedPaths: string[]; keptPaths: string[]; error?: string }
  | { step: 'retired'; branch: string; baseBranch: string }
  | { step: 'completed-in-place'; baseBranch: string; leftBranch?: string }
  | { step: 'reconciled'; fromBase: string; toBase: string; mergeOid: string }
  | { step: 'rebuilding'; fromBase: string; toBase: string; paths: string[] }
  | { step: 'escalated'; reason: 'conflict' | 'post-merge-red' | 'target-advanced'; message: string };

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

export function mergeStepRow(step: MergeStepEvent, index: number): MergeStepRow {
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
    case 'checkout-synced': {
      if (step.error) {
        return { key, label: 'Checkout sync failed', detail: null, log: step.error, tone: 'failed' };
      }
      const detailParts: string[] = [];
      if (step.mergedPaths.length > 0) detailParts.push(step.mergedPaths.length === 1 ? '1 file merged' : `${step.mergedPaths.length} files merged`);
      if (step.keptPaths.length > 0) {
        detailParts.push(step.keptPaths.length === 1 ? '1 file kept your local version — reconcile it' : `${step.keptPaths.length} files kept your local version — reconcile them`);
      }
      const log = step.mergedPaths.length + step.keptPaths.length > 0 ? [...step.mergedPaths.map((p) => `merged: ${p}`), ...step.keptPaths.map((p) => `kept: ${p}`)].join('\n') : null;
      return {
        key,
        label: 'Checkout synced',
        detail: detailParts.length > 0 ? detailParts.join(', ') : 'no local changes to reconcile',
        log,
        tone: step.keptPaths.length > 0 ? 'awaiting' : 'passed',
      };
    }
    case 'retired':
      return { key, label: 'Integration branch retired', detail: step.branch, log: `Merged into ${step.baseBranch}`, tone: 'passed' };
    case 'completed-in-place':
      return {
        key,
        label: 'Completed in place',
        detail: step.baseBranch,
        log: step.leftBranch ? `${step.leftBranch} left untouched; Harmonic no longer uses it` : null,
        tone: 'passed',
      };
    case 'reconciled':
      return {
        key,
        label: 'Reconciled onto moved base',
        detail: `${shortOid(step.fromBase)} → ${shortOid(step.toBase)}`,
        log: `Merge ${shortOid(step.mergeOid)} reconciled onto ${step.toBase}`,
        tone: 'passed',
      };
    case 'rebuilding':
      return {
        key,
        label: 'Rebuilding on moved base',
        detail: step.paths.length === 0 ? `${shortOid(step.fromBase)} → ${shortOid(step.toBase)}` : step.paths.length === 1 ? '1 conflicting file' : `${step.paths.length} conflicting files`,
        log: step.paths.length > 0 ? step.paths.join('\n') : null,
        tone: 'running',
      };
    case 'escalated':
      return {
        key,
        label: step.reason === 'conflict' ? 'Escalated — merge conflict' : step.reason === 'target-advanced' ? 'Escalated — base advanced' : 'Escalated — post-merge check failed',
        detail: null,
        log: step.message,
        tone: 'awaiting',
      };
  }
}

/** Turn an ordered merge-step log into display rows. */
export function mergeStepRows(steps: readonly MergeStepEvent[]): MergeStepRow[] {
  return steps.map(mergeStepRow);
}
