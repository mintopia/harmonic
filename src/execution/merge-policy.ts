import { Git } from './git.js';
import { withEphemeralMergeWorktree } from './ephemeral-merge-worktree.js';
import { withBaseCheckoutLock } from './repo-lock.js';
import { captureDirtyPaths, syncBaseCheckout } from './base-checkout-sync.js';
import { startActiveChildOperation, type Operation } from '../telemetry/operations.js';
import { logger } from '../logger.js';

function within<T>(operation: Operation | undefined, work: () => Promise<T>): Promise<T> {
  return operation ? operation.run(work) : work();
}

// How many times to rebuild an isolated merge onto the current base tip when the
// base branch advances under it (concurrent merges on the same base, issue #121)
// before giving up and escalating as target-advanced.
const MAX_MERGE_ATTEMPTS = 8;

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
  // Observe each merge step as it happens, for the merge-visibility timeline.
  // Must never throw and must not block: the policy fires it and moves on.
  onStep?: (event: MergeStepEvent) => void;
}

/** One observable step of a single merge, in emission order, for the merge-visibility timeline. */
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
  | { step: 'escalated'; reason: 'conflict' | 'post-merge-red' | 'target-advanced'; message: string };

function emitStep(deps: MergePolicyDeps, event: MergeStepEvent): void {
  try {
    deps.onStep?.(event);
  } catch (err) {
    // A visibility sink must never break the merge it observes, but a
    // throwing onStep is a bug in the caller's contract (it "must never
    // throw") worth surfacing.
    logger.warn('merge: onStep visibility sink threw', {
      'merge.step': event.step,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface MergePolicyInput {
  baseDir: string; // persistent repository checkout: its repo identity is the mutex key and it owns baseBranch
  baseBranch: string;
  taskBranch: string;
  conflictResolveTurns: number; // bounded agentic resolve turns; 0 => escalate on first conflict
  postMergeCheck: boolean; // run the post-merge deterministic check in the isolated worktree
  spanAttributes?: Record<string, string | number | boolean>; // extra attributes for the merge span (e.g. run.id)
}

export type MergePolicyOutcome =
  | { kind: 'merged'; mergeOid: string }
  | { kind: 'escalated'; reason: 'conflict' | 'post-merge-red' | 'target-advanced'; message: string };

function conflictMessage(taskBranch: string, baseBranch: string, conflictResolveTurns: number): string {
  if (conflictResolveTurns === 0) {
    return `Merging ${taskBranch} into ${baseBranch} hit conflicts and automated resolution is disabled (0 resolve turns); a human needs to resolve them.`;
  }
  const turns = conflictResolveTurns === 1 ? '1 automated resolve turn' : `${conflictResolveTurns} automated resolve turns`;
  return `Merging ${taskBranch} into ${baseBranch} hit conflicts that ${turns} could not settle; a human needs to resolve them.`;
}

function postMergeRedMessage(taskBranch: string, baseBranch: string, output: string): string {
  return `The post-merge check on ${baseBranch} failed after merging ${taskBranch}; the merge was discarded and the base is unchanged.\n\nFailing output:\n${output}`;
}

async function escalateConflict(input: MergePolicyInput): Promise<MergePolicyOutcome> {
  await Git.abortMerge(input.baseDir);
  const message = conflictMessage(input.taskBranch, input.baseBranch, input.conflictResolveTurns);
  return { kind: 'escalated', reason: 'conflict', message };
}

async function resolveConflict(
  input: MergePolicyInput,
  deps: MergePolicyDeps,
): Promise<{ mergeOid: string } | { escalated: true }> {
  for (let turn = 1; turn <= input.conflictResolveTurns; turn++) {
    const unmerged = await Git.unmergedPaths(input.baseDir);
    if (unmerged.length === 0) break;

    const turnOp = startActiveChildOperation('merge.resolve', {
      'merge.turn': turn,
      'merge.unmerged_count': unmerged.length,
    });
    logger.info('merge: resolving conflicts', { 'merge.turn': turn, 'merge.unmerged_count': unmerged.length });
    emitStep(deps, { step: 'resolve-turn', turn, unmergedCount: unmerged.length });
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

    const stillUnmerged = await Git.unmergedPaths(input.baseDir);
    const settled: { mergeOid: string } | 'remain' | 'failed' = stillUnmerged.length > 0
      ? 'remain'
      : await Git.completeMerge(input.baseDir).then((done) => (done.ok ? { mergeOid: done.mergeOid } : 'failed'));
    if (settled === 'remain') {
      logger.warn('merge: conflicts remain after resolve turn', {
        'merge.turn': turn,
        'merge.unmerged_count': stillUnmerged.length,
      });
    }
    if (typeof settled === 'object') {
      logger.info('merge: completed after resolution', { 'merge.turn': turn, 'merge.oid': settled.mergeOid });
    }
    if (typeof settled === 'object') return settled;
    if (settled === 'failed') break;
  }
  return { escalated: true };
}

async function criticalSection(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  const merge = await Git.mergeNoFf(input.baseDir, input.taskBranch);
  if (!merge.ok && !merge.conflict) throw new Error(merge.detail);
  const started: { mergeOid: string } | { conflict: true; paths: string[] } = merge.ok
    ? { mergeOid: merge.mergeOid }
    : { conflict: true, paths: await Git.unmergedPaths(input.baseDir) };
  if ('conflict' in started) {
    logger.warn('merge: conflicts detected', { 'merge.task_branch': input.taskBranch, 'merge.unmerged_count': started.paths.length });
  }

  let mergeOid: string;
  if ('mergeOid' in started) {
    mergeOid = started.mergeOid;
  } else {
    emitStep(deps, { step: 'conflict', paths: started.paths });
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
      logger.warn('merge: post-merge check failed; discarding isolated merge', { 'merge.oid': mergeOid });
      const message = postMergeRedMessage(input.taskBranch, input.baseBranch, check.output);
      return { kind: 'escalated', reason: 'post-merge-red', message };
    }
    emitStep(deps, { step: 'post-check-passed', mergeOid });
  } else {
    emitStep(deps, { step: 'post-check-skipped', mergeOid });
  }

  return { kind: 'merged', mergeOid };
}

async function mergeUnderLock(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  // The base can move between building the isolated merge and committing it to
  // the base branch (a concurrent merge on the same base branch, issue #121).
  // Accommodate it: rebuild the merge onto the new tip and retry, bounded,
  // rather than escalating. Only a real conflict or a red post-merge check escalates.
  for (let attempt = 1; ; attempt++) {
    const expectedBaseOid = await Git.revParse(input.baseDir, input.baseBranch);
    const outcome = await withEphemeralMergeWorktree(
      {
        repoDir: input.baseDir,
        baseTipOid: expectedBaseOid,
        onRemoveError: ({ error, worktreeDir: adminPath }) => {
          logger.warn('merge: removing the isolated worktree failed', {
            'merge.repo': input.baseDir,
            'merge.admin_path': adminPath,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
      (adminPath) => criticalSection({ ...input, baseDir: adminPath }, deps),
    );
    if (outcome.kind === 'escalated') return outcome;

    const waitOp = startActiveChildOperation('merge.lock-wait', { 'merge.repo': input.baseDir });
    logger.debug('merge: awaiting base checkout lock', { 'merge.repo': input.baseDir });
    const committed = await withBaseCheckoutLock(input.baseDir, async (): Promise<{ ok: boolean; detail?: string }> => {
      waitOp?.end();
      logger.debug('merge: base checkout lock acquired', { 'merge.repo': input.baseDir });
      const holdOp = startActiveChildOperation('merge.lock-hold', { 'merge.repo': input.baseDir });
      try {
        return await within(holdOp, async () => {
          // Snapshot dirty paths BEFORE the ref moves, or a moved ref makes a
          // clean tree look dirty.
          const checkoutDir = await Git.branchCheckedOutAt(input.baseDir, input.baseBranch);
          const dirtyPaths = checkoutDir !== null ? await captureDirtyPaths(checkoutDir) : null;
          const result = await Git.casUpdateRef(input.baseDir, input.baseBranch, outcome.mergeOid, expectedBaseOid);
          // Runs after the ref is already published, so a failure here must
          // never fail or reverse the merge.
          if (result.ok && checkoutDir !== null) {
            try {
              const sync = await syncBaseCheckout(checkoutDir, dirtyPaths!, expectedBaseOid, outcome.mergeOid);
              emitStep(deps, { step: 'checkout-synced', mergeOid: outcome.mergeOid, mergedPaths: sync.mergedPaths, keptPaths: sync.keptPaths });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logger.warn('merge: syncing the base checkout after a successful merge failed', {
                'merge.repo': input.baseDir,
                'merge.oid': outcome.mergeOid,
                error: message,
              });
              emitStep(deps, { step: 'checkout-synced', mergeOid: outcome.mergeOid, mergedPaths: [], keptPaths: [], error: message });
            }
          }
          return result;
        });
      } finally {
        holdOp?.end();
        logger.debug('merge: base checkout lock released', { 'merge.repo': input.baseDir });
      }
    });
    if (committed.ok) return outcome;
    if (attempt >= MAX_MERGE_ATTEMPTS) {
      return {
        kind: 'escalated',
        reason: 'target-advanced',
        message: `The base branch '${input.baseBranch}' advanced before the isolated merge could be committed after ${attempt} attempts: ${committed.detail ?? 'CAS update failed'}`,
      };
    }
    logger.info('merge: base advanced before the merge could be committed; rebuilding on the new tip', {
      'merge.repo': input.baseDir,
      'merge.base_branch': input.baseBranch,
      'merge.attempt': attempt,
    });
  }
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
      emitStep(deps, { step: 'started', baseBranch: input.baseBranch, taskBranch: input.taskBranch });

      const outcome = await mergeUnderLock(input, deps);

      if (outcome.kind === 'escalated') {
        logger.warn('merge: escalating', { 'merge.reason': outcome.reason });
        await deps.escalate(outcome.message);
        mergeOp?.update({ 'merge.outcome': 'escalated', 'merge.reason': outcome.reason });
        emitStep(deps, { step: 'escalated', reason: outcome.reason, message: outcome.message });
      } else {
        logger.info('merge: merged', { 'merge.oid': outcome.mergeOid });
        mergeOp?.update({ 'merge.outcome': 'merged', 'merge.oid': outcome.mergeOid });
        emitStep(deps, { step: 'merged', mergeOid: outcome.mergeOid });
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
