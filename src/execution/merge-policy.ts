import { Git } from './git.js';
import { withBaseCheckoutLock, withRepoLock } from './repo-lock.js';
import { startActiveChildOperation, type Operation } from '../telemetry/operations.js';
import { logger } from '../logger.js';

function within<T>(operation: Operation | undefined, work: () => Promise<T>): Promise<T> {
  return operation ? operation.run(work) : work();
}

export interface ConflictResolveContext {
  baseDir: string;
  baseBranch: string;
  taskBranch: string;
  unmergedPaths: string[];
  turn: number; // 1-based
}

export interface PostMergeCheckResult {
  pass: boolean;
  output: string; // failing command output to surface on escalation; empty when pass
}

export interface MergePolicyDeps {
  // Drive one bounded agentic resolve turn against the conflicted base checkout.
  // The turn edits files and `git add`s them in ctx.baseDir; the policy re-checks
  // for remaining conflicts and completes the merge commit itself.
  resolveConflictTurn: (ctx: ConflictResolveContext) => Promise<void>;
  // Run the deterministic verify commands once against the merged base tip.
  // Only invoked when input.postMergeCheck is true.
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
  // Escalate the task with a composed plain-language reason (NEVER a raw git conflict dump).
  escalate: (reason: string) => Promise<void>;
}

export interface MergePolicyInput {
  baseDir: string; // base checkout: baseBranch is its HEAD; merge/revert happen here; its repo identity is the mutex key
  baseBranch: string;
  taskBranch: string;
  conflictResolveTurns: number; // bounded agentic resolve turns; 0 => escalate on first conflict
  postMergeCheck: boolean; // run the post-merge deterministic check under the mutex
  spanAttributes?: Record<string, string | number | boolean>; // extra attributes for the merge span (e.g. run.id)
}

export type MergePolicyOutcome =
  | { kind: 'merged'; mergeOid: string }
  | { kind: 'escalated'; reason: 'conflict' | 'post-merge-red'; message: string; revertOid?: string };

function conflictMessage(taskBranch: string, baseBranch: string, conflictResolveTurns: number): string {
  if (conflictResolveTurns === 0) {
    return `Merging ${taskBranch} into ${baseBranch} hit conflicts and automated resolution is disabled (0 resolve turns); a human needs to resolve them.`;
  }
  const turns = conflictResolveTurns === 1 ? '1 automated resolve turn' : `${conflictResolveTurns} automated resolve turns`;
  return `Merging ${taskBranch} into ${baseBranch} hit conflicts that ${turns} could not settle; a human needs to resolve them.`;
}

function postMergeRedMessage(taskBranch: string, baseBranch: string, output: string): string {
  return `The post-merge check on ${baseBranch} failed after merging ${taskBranch}; the merge was reverted so the base stays green.\n\nFailing output:\n${output}`;
}

async function escalateConflict(input: MergePolicyInput): Promise<MergePolicyOutcome> {
  await withRepoLock(input.baseDir, () => Git.abortMerge(input.baseDir));
  const message = conflictMessage(input.taskBranch, input.baseBranch, input.conflictResolveTurns);
  return { kind: 'escalated', reason: 'conflict', message };
}

async function resolveConflict(
  input: MergePolicyInput,
  deps: MergePolicyDeps,
): Promise<{ mergeOid: string } | { escalated: true }> {
  for (let turn = 1; turn <= input.conflictResolveTurns; turn++) {
    const unmerged = await withRepoLock(input.baseDir, () => Git.unmergedPaths(input.baseDir));
    if (unmerged.length === 0) break;

    const turnOp = startActiveChildOperation('merge.resolve', {
      'merge.turn': turn,
      'merge.unmerged_count': unmerged.length,
    });
    logger.info('merge: resolving conflicts', { 'merge.turn': turn, 'merge.unmerged_count': unmerged.length });
    try {
      await within(turnOp, () =>
        deps.resolveConflictTurn({
          baseDir: input.baseDir,
          baseBranch: input.baseBranch,
          taskBranch: input.taskBranch,
          unmergedPaths: unmerged,
          turn,
        }),
      );
    } finally {
      turnOp?.end();
    }

    const settled = await withRepoLock(
      input.baseDir,
      async (): Promise<{ mergeOid: string } | 'remain' | 'failed'> => {
        const stillUnmerged = await Git.unmergedPaths(input.baseDir);
        if (stillUnmerged.length > 0) {
          logger.warn('merge: conflicts remain after resolve turn', {
            'merge.turn': turn,
            'merge.unmerged_count': stillUnmerged.length,
          });
          return 'remain';
        }
        const done = await Git.completeMerge(input.baseDir);
        if (done.ok) {
          logger.info('merge: completed after resolution', { 'merge.turn': turn, 'merge.oid': done.mergeOid });
          return { mergeOid: done.mergeOid };
        }
        return 'failed';
      },
    );
    if (typeof settled === 'object') return settled;
    if (settled === 'failed') break;
  }
  return { escalated: true };
}

async function criticalSection(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  const parkedBranch = await Git.currentBranch(input.baseDir).catch(() => null);
  try {
    const started = await withRepoLock(
      input.baseDir,
      async (): Promise<{ mergeOid: string } | { conflict: true }> => {
        if (parkedBranch !== input.baseBranch) {
          logger.info('merge: checking out base branch', { 'merge.base_branch': input.baseBranch });
          await Git.checkout(input.baseDir, input.baseBranch);
        }
        const merge = await Git.mergeNoFf(input.baseDir, input.taskBranch);
        if (merge.ok) return { mergeOid: merge.mergeOid };
        if (merge.conflict) {
          logger.warn('merge: conflicts detected', { 'merge.task_branch': input.taskBranch });
          return { conflict: true };
        }
        throw new Error(merge.detail);
      },
    );

    let mergeOid: string;
    if ('mergeOid' in started) {
      mergeOid = started.mergeOid;
    } else {
      const resolved = await resolveConflict(input, deps);
      if ('escalated' in resolved) return escalateConflict(input);
      mergeOid = resolved.mergeOid;
    }

    if (input.postMergeCheck) {
      const checkOp = startActiveChildOperation('merge.post-check', { 'merge.oid': mergeOid });
      logger.info('merge: running post-merge check', { 'merge.oid': mergeOid });
      const check = await within(checkOp, () => deps.runPostMergeCheck(mergeOid, input.baseDir));
      checkOp?.update({ 'merge.post_check_pass': check.pass });
      checkOp?.end();
      if (!check.pass) {
        logger.warn('merge: post-merge check failed; reverting', { 'merge.oid': mergeOid });
        const revertOid = await withRepoLock(input.baseDir, () => Git.revertMergeCommit(input.baseDir, mergeOid));
        const message = postMergeRedMessage(input.taskBranch, input.baseBranch, check.output);
        logger.warn('merge: reverted to keep base green', { 'merge.revert_oid': revertOid });
        return { kind: 'escalated', reason: 'post-merge-red', message, revertOid };
      }
    }

    return { kind: 'merged', mergeOid };
  } finally {
    if (parkedBranch && parkedBranch !== input.baseBranch) {
      await withRepoLock(input.baseDir, () => Git.checkout(input.baseDir, parkedBranch).catch(() => {}));
    }
  }
}

async function mergeUnderLock(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  const waitOp = startActiveChildOperation('merge.lock-wait', { 'merge.repo': input.baseDir });
  logger.debug('merge: awaiting base checkout lock', { 'merge.repo': input.baseDir });
  return withBaseCheckoutLock(input.baseDir, async (): Promise<MergePolicyOutcome> => {
    waitOp?.end();
    logger.debug('merge: base checkout lock acquired', { 'merge.repo': input.baseDir });
    const holdOp = startActiveChildOperation('merge.lock-hold', { 'merge.repo': input.baseDir });
    try {
      return await within(holdOp, () => criticalSection(input, deps));
    } finally {
      holdOp?.end();
      logger.debug('merge: base checkout lock released', { 'merge.repo': input.baseDir });
    }
  });
}

export async function runMergePolicy(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  const mergeOp = startActiveChildOperation('merge', {
    'merge.mechanism': 'policy',
    'merge.base_branch': input.baseBranch,
    'merge.task_branch': input.taskBranch,
    ...(input.spanAttributes ?? {}),
  });
  return within(mergeOp, async () => {
    try {
      logger.info('merge: starting', {
        'merge.base_branch': input.baseBranch,
        'merge.task_branch': input.taskBranch,
        'merge.conflict_resolve_turns': input.conflictResolveTurns,
        'merge.post_merge_check': input.postMergeCheck,
      });

      const outcome = await mergeUnderLock(input, deps);

      if (outcome.kind === 'escalated') {
        logger.warn('merge: escalating', { 'merge.reason': outcome.reason });
        await deps.escalate(outcome.message);
        mergeOp?.update({ 'merge.outcome': 'escalated', 'merge.reason': outcome.reason });
      } else {
        logger.info('merge: merged', { 'merge.oid': outcome.mergeOid });
        mergeOp?.update({ 'merge.outcome': 'merged', 'merge.oid': outcome.mergeOid });
      }

      mergeOp?.end();
      return outcome;
    } catch (error) {
      logger.error('merge: failed', { 'merge.error': error instanceof Error ? error.message : String(error) });
      mergeOp?.fail(error);
      throw error;
    }
  });
}
