import { Git } from './git.js';
import { withEphemeralMergeWorktree } from './ephemeral-merge-worktree.js';
import { withBaseCheckoutLock } from './repo-lock.js';
import { captureDirtyPaths, syncBaseCheckout } from './base-checkout-sync.js';
import { startActiveChildOperation, type Operation } from '../telemetry/operations.js';
import { logger } from '../logger.js';

function within<T>(operation: Operation | undefined, work: () => Promise<T>): Promise<T> {
  return operation ? operation.run(work) : work();
}

// How many times a reconcile conflict (the moved base textually clashes with
// the build) triggers a rebuild before escalating (ADR-0040). An ordinary
// base advance never rebuilds at all — it reconciles under the lock.
const MAX_RECONCILE_REBUILDS = 2;

// Same bound, but generous, for the git < 2.38 fallback where every base
// advance forces a rebuild (no worktree-free reconcile primitive available).
const UNSUPPORTED_GIT_MAX_REBUILDS = 8;

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
  | { step: 'reconciled'; fromBase: string; toBase: string; mergeOid: string }
  | { step: 'rebuilding'; fromBase: string; toBase: string; paths: string[] }
  // 'target-advanced' is kept here only to read pre-ADR-0040 persisted rows;
  // nothing emits it anymore (see MergePolicyOutcome, which never produces it).
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
  | { kind: 'escalated'; reason: 'conflict' | 'post-merge-red'; message: string };

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

function reconcileConflictMessage(taskBranch: string, baseBranch: string, rebuilds: number): string {
  return `Merging ${taskBranch} into ${baseBranch} kept conflicting with changes arriving on ${baseBranch} (rebuilt ${rebuilds} times); a human needs to resolve them.`;
}

function unsupportedGitMessage(taskBranch: string, baseBranch: string, rebuilds: number): string {
  return `Merging ${taskBranch} into ${baseBranch} could not be reconciled after ${rebuilds} rebuilds because this git is older than 2.38 and has no \`merge-tree --write-tree\` to reconcile a moved base without rebuilding each time; upgrade git to 2.38 or newer.`;
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

type PublishResult =
  | { kind: 'published'; mergeOid: string }
  | { kind: 'reconcile-conflict'; currentTip: string; paths: string[]; unsupported: boolean }
  | { kind: 'write-failed'; detail: string };

/**
 * Publish `mergeOid` (built off `snapshotOid`) onto the base branch. Runs
 * under the base-checkout lock. When the current tip has not moved, publishes
 * `mergeOid` directly; when it has, reconciles onto it (ADR-0040) rather than
 * asserting the snapshot is still current. `casUpdateRef`'s old-value is only
 * ever the tip THIS iteration just read, so a miss (a writer outside the
 * lock — the operator, direct mode) never rejects: it re-reads the tip and
 * reconciles the ORIGINAL build onto it again, unbounded.
 */
async function publish(input: MergePolicyInput, deps: MergePolicyDeps, mergeOid: string, snapshotOid: string): Promise<PublishResult> {
  for (;;) {
    const tip = await Git.revParse(input.baseDir, input.baseBranch);
    let toPublish: string;
    if (tip === snapshotOid) {
      toPublish = mergeOid;
    } else {
      const reconciled = await Git.reconcileMerge(input.baseDir, tip, mergeOid);
      if (!reconciled.ok) {
        return {
          kind: 'reconcile-conflict',
          currentTip: tip,
          paths: 'paths' in reconciled ? reconciled.paths : [],
          unsupported: 'unsupported' in reconciled,
        };
      }
      toPublish = reconciled.mergeOid;
    }

    const checkoutDir = await Git.branchCheckedOutAt(input.baseDir, input.baseBranch);
    const dirtyPaths = checkoutDir !== null ? await captureDirtyPaths(checkoutDir) : null;
    const cas = await Git.casUpdateRef(input.baseDir, input.baseBranch, toPublish, tip);
    if (!cas.ok) {
      const tipAfter = await Git.revParse(input.baseDir, input.baseBranch);
      if (tipAfter !== tip) {
        logger.warn('merge: lost the publish race to a writer outside the lock; re-reading the tip and reconciling again', {
          'merge.repo': input.baseDir,
          'merge.base_branch': input.baseBranch,
        });
        continue;
      }
      // The tip didn't move, so the write failed for a reason other than a lost
      // race (a stale lock file, a permissions error, a corrupt ref) — looping
      // would spin forever holding the base-checkout lock. Stop and escalate;
      // nothing was published, so the merge stays retryable.
      return { kind: 'write-failed', detail: cas.detail ?? 'update-ref failed' };
    }

    if (tip !== snapshotOid) emitStep(deps, { step: 'reconciled', fromBase: snapshotOid, toBase: tip, mergeOid: toPublish });

    if (checkoutDir !== null) {
      try {
        const sync = await syncBaseCheckout(checkoutDir, dirtyPaths!, tip, toPublish);
        emitStep(deps, { step: 'checkout-synced', mergeOid: toPublish, mergedPaths: sync.mergedPaths, keptPaths: sync.keptPaths });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('merge: syncing the base checkout after a successful merge failed', {
          'merge.repo': input.baseDir,
          'merge.oid': toPublish,
          error: message,
        });
        emitStep(deps, { step: 'checkout-synced', mergeOid: toPublish, mergedPaths: [], keptPaths: [], error: message });
      }
    }

    return { kind: 'published', mergeOid: toPublish };
  }
}

async function mergeUnderLock(input: MergePolicyInput, deps: MergePolicyDeps): Promise<MergePolicyOutcome> {
  let baseTipOid = await Git.revParse(input.baseDir, input.baseBranch);
  let reconcileRebuilds = 0;
  let unsupportedRebuilds = 0;

  for (;;) {
    const built = await withEphemeralMergeWorktree(
      {
        repoDir: input.baseDir,
        baseTipOid,
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
    if (built.kind === 'escalated') return built;

    const waitOp = startActiveChildOperation('merge.lock-wait', { 'merge.repo': input.baseDir });
    logger.debug('merge: awaiting base checkout lock', { 'merge.repo': input.baseDir });
    const published = await withBaseCheckoutLock(input.baseDir, async (): Promise<PublishResult> => {
      waitOp?.end();
      logger.debug('merge: base checkout lock acquired', { 'merge.repo': input.baseDir });
      const holdOp = startActiveChildOperation('merge.lock-hold', { 'merge.repo': input.baseDir });
      try {
        return await within(holdOp, () => publish(input, deps, built.mergeOid, baseTipOid));
      } finally {
        holdOp?.end();
        logger.debug('merge: base checkout lock released', { 'merge.repo': input.baseDir });
      }
    });
    if (published.kind === 'published') return { kind: 'merged', mergeOid: published.mergeOid };

    if (published.kind === 'write-failed') {
      return { kind: 'escalated', reason: 'conflict', message: `Couldn't update ${input.baseBranch}: ${published.detail}` };
    }

    emitStep(deps, { step: 'rebuilding', fromBase: baseTipOid, toBase: published.currentTip, paths: published.paths });
    logger.warn('merge: reconcile conflict; rebuilding onto the new base tip', {
      'merge.repo': input.baseDir,
      'merge.base_branch': input.baseBranch,
      'merge.unsupported': published.unsupported,
    });

    if (published.unsupported) {
      unsupportedRebuilds++;
      if (unsupportedRebuilds > UNSUPPORTED_GIT_MAX_REBUILDS) {
        return { kind: 'escalated', reason: 'conflict', message: unsupportedGitMessage(input.taskBranch, input.baseBranch, UNSUPPORTED_GIT_MAX_REBUILDS) };
      }
    } else {
      reconcileRebuilds++;
      if (reconcileRebuilds > MAX_RECONCILE_REBUILDS) {
        return { kind: 'escalated', reason: 'conflict', message: reconcileConflictMessage(input.taskBranch, input.baseBranch, MAX_RECONCILE_REBUILDS) };
      }
    }
    baseTipOid = published.currentTip;
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
