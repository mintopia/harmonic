import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import { Git } from './git.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * Journaled, crash-idempotent branch merging (issue #153, reliability-design
 * Unit D, ADR-0023).
 *
 * "Merging" the `target-ref` effect means advancing a target branch to include
 * a Run's work. The naive way — check the base branch out in the shared repo
 * and `git merge` in place (the pre-#153 `Git.merge`) — mutates whatever
 * checkout happens to be on that branch, so a concurrent operator working tree
 * (or another Run) is silently desynchronised. This module merges **without
 * ever touching a live checkout it isn't explicitly cleared to reset**:
 *
 *  1. The merge is computed in a **dedicated administrative worktree** detached
 *     at the target's current tip — the conflict/abort, if any, happens off to
 *     the side and the live target checkout is never entered.
 *  2. If **no worktree has the target checked out**, the branch ref is advanced
 *     with an **expected-old-OID CAS** ({@link Git.casUpdateRef}): a hand-merge
 *     or another merging that moved the target in between is rejected, not
 *     overwritten.
 *  3. If a worktree **does** have the target checked out (a worktree-mode base
 *     repo sitting on the base branch, or a direct-mode live checkout), a
 *     plumbing ref-update would desync it. So merging happens **only under the
 *     merge mutex** (`mutexHeld` + the checkout being clean) via a
 *     **coherent `merge --ff-only`** that advances the ref and the working tree
 *     together. Absent that mutex, or over a dirty checkout, it **falls back to
 *     PR/manual** (`ok:false`, `reason:'fallback-pr-manual'`) rather than risk
 *     the desync — the operator merges it by hand.
 *
 * Idempotent by construction, which is what makes it crash-safe: re-running a
 * merge whose branch is already merged is an "Already up to date" no-op (the
 * admin merge leaves HEAD at the base tip, and the CAS / ff-only to that same
 * OID is a no-op success). A crash after the ref moved but before the result
 * was journaled therefore reconciles (issue #115 `reconcile` → `adopt`, or a
 * plain re-invocation) without a duplicate merge or a false conflict.
 *
 * Pure of the database and the Runner, like `candidate.ts`: it takes explicit
 * paths/revisions and calls only `Git.*`, so every branch of the decision is
 * exhaustively testable against a
 * throwaway git repo. The `mutexHeld` gate is the one thing the caller must
 * supply, because whether the merge mutex is held is a fact about the
 * Runner's world this module deliberately does not reach into.
 */

export interface MergeIntoBaseArgs {
  /** The base repo that owns the target ref and the object store. */
  repoDir: string;
  /** The target branch being advanced (a short name, e.g. `main`). */
  baseBranch: string;
  /** The Run's branch whose work is being merged into `baseBranch`. */
  branch: string;
  /** Exact branch tip verified for this merging. The merge consumes this OID,
   * never a later resolution of `branch`. */
  expectedOid: string;
  /** `'fast-forward'` (default) merges only a tip that already contains the
   * base's current tip — verification saw exactly the merged tree (ADR-0041);
   * a base that advanced since is refused as `stale-base`. `'merge'` folds a
   * diverged base in with a merge commit: integration-branch refreshes, where
   * the "branch" is the default branch being merged into `epic/<ref>`. */
  mode?: 'fast-forward' | 'merge';
  /**
   * The merge mutex is held over the target checkout, permitting a coherent
   * in-place merge of a **checked-out** target. When the target is not
   * checked out this is irrelevant (the CAS ref-update needs no mutex). Default
   * `false` — a checked-out target with no asserted mutex falls back to
   * PR/manual rather than risk desyncing a checkout this module can't vouch for.
   */
  mutexHeld?: boolean;
  /**
   * Parent directory for the dedicated admin worktree. A fresh unique child of
   * it is created (and removed) per merge, so concurrent merges never collide.
   * Defaults to the OS temp dir.
   */
  adminWorktreeParent?: string;
  parent?: SpanContext;
  attributes?: Attributes;
}

/** Best-effort notification after a branch merge has succeeded. `repoDir` is
 * the workspace's persistent base repo checkout, never a task checkout. */
export type PostMergeHook = (args: Pick<MergeIntoBaseArgs, 'repoDir' | 'baseBranch'>) => void | Promise<void>;

/**
 * The repository default the post-merge refresh decision compares against: the
 * base repo's live symbolic HEAD — the same convention the whole-Epic merge
 * uses (`epic-merge-coordinator.ts`). Falls back to the configured
 * `origin/HEAD` only when that checkout is detached (a concurrent direct Run,
 * issue #152); a detached non-clone therefore resolves `null` and no refresh
 * fires, rather than guessing.
 */
export async function resolveRepositoryDefaultBranch(repoDir: string): Promise<string | null> {
  return (await Git.symbolicBranch(repoDir)) ?? Git.defaultBranch(repoDir);
}

/**
 * Build the post-merge observer for default-branch advances. The resolver runs
 * against the hook's `repoDir` — the workspace's persistent base repo — never
 * the checkout a direct-mode merge happens to run from, so a feature-branch
 * merge can't masquerade as a default-branch advance.
 */
export function defaultBranchPostMerge(
  refreshAfterDefaultBranchAdvance: (repoDir: string, defaultBranch: string) => Promise<void>,
  resolveDefaultBranch: (repoDir: string) => Promise<string | null> = resolveRepositoryDefaultBranch,
): PostMergeHook {
  return async ({ repoDir, baseBranch }) => {
    const defaultBranch = await resolveDefaultBranch(repoDir);
    if (defaultBranch !== baseBranch || defaultBranch === null) return;
    await refreshAfterDefaultBranchAdvance(repoDir, defaultBranch);
  };
}

export type MergeIntoBaseOutcome =
  | { ok: true; mode: 'cas' | 'in-place'; oid: string; baseBranch: string; branch: string }
  | { ok: false; reason: 'conflict' | 'target-advanced' | 'stale-head' | 'stale-base' | 'fallback-pr-manual'; detail: string };

/** Run the one shared success-only post-merge hook around a branch merge.
 * `baseRepoDir` is the workspace's persistent base repo checkout, for the
 * direct-mode case where the merge's own `repoDir` is a task checkout parked on
 * the task's branch — the hook's default-branch decision must resolve against
 * the former. Omitted, `repoDir` already is the base repo. */
export async function mergeIntoBaseAndRunPostMerge(
  args: MergeIntoBaseArgs & { baseRepoDir?: string },
  postMerge: PostMergeHook | undefined,
  merge: (args: MergeIntoBaseArgs) => Promise<MergeIntoBaseOutcome> = mergeIntoBase,
): Promise<MergeIntoBaseOutcome> {
  const outcome = await merge(args);
  if (outcome.ok) await postMerge?.({ repoDir: args.baseRepoDir ?? args.repoDir, baseBranch: args.baseBranch });
  return outcome;
}

/**
 * Merge `branch` into `baseBranch` per the module contract. Never throws for an
 * expected merging failure (conflict, a moved target, the mutex not held) — those
 * are `{ ok:false }` outcomes the caller journals and surfaces exactly as the
 * pre-#153 merge conflict was; only a genuine git/plumbing fault propagates.
 */
export async function mergeIntoBase(args: MergeIntoBaseArgs): Promise<MergeIntoBaseOutcome> {
  const operation = args.parent
    ? startOperation({ type: 'merge', parent: args.parent, attributes: { 'merge.mechanism': 'branch', ...args.attributes } })
    : undefined;
  try {
    const outcome = operation ? await operation.run(() => mergeIntoBaseUnchecked(args)) : await mergeIntoBaseUnchecked(args);
    if (outcome.ok) operation?.end();
    else operation?.fail(outcome.detail);
    return outcome;
  } catch (error) {
    operation?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function mergeIntoBaseUnchecked(args: MergeIntoBaseArgs): Promise<MergeIntoBaseOutcome> {
  const { repoDir, baseBranch, branch, expectedOid } = args;
  // Resolve the mutable ref once, at the merging boundary, then merge the
  // immutable verified object. A moved branch can never slip through the
  // merging window and merge a tree that verification did not inspect.
  const branchOid = await Git.revParse(repoDir, branch).catch(() => null);
  if (branchOid !== expectedOid) {
    return { ok: false, reason: 'stale-head', detail: `branch '${branch}' moved after verification` };
  }
  const expectedOld = await Git.revParse(repoDir, baseBranch);

  // Step 1: the object to merge. A fast-forward merges the verified tip itself;
  // a merge is computed in a dedicated admin worktree detached at the target's
  // current tip — the live target checkout is never entered, so a conflict
  // aborts against a throwaway tree and the base repo stays pristine.
  let newOid: string;
  if (args.mode === 'merge') {
    const parent = mkdtempSync(join(args.adminWorktreeParent ?? tmpdir(), 'harmonic-merge-'));
    const adminPath = join(parent, 'admin');
    try {
      await Git.addDetachedWorktree(repoDir, adminPath, expectedOld);
      const merged = await Git.mergeNoEdit(adminPath, expectedOid);
      if (!merged.ok) {
        return { ok: false, reason: 'conflict', detail: merged.detail ?? 'merge conflict' };
      }
      newOid = await Git.revParse(adminPath, 'HEAD');
    } finally {
      await Git.removeWorktree(repoDir, adminPath).catch(() => {});
      rmSync(parent, { recursive: true, force: true });
    }
  } else if (await Git.isAncestor(repoDir, expectedOid, expectedOld)) {
    // The base is still contained in the verified candidate: merge its tip as-is,
    // the exact tree verification inspected.
    newOid = expectedOid;
  } else {
    return { ok: false, reason: 'stale-base', detail: `base '${baseBranch}' advanced after verification; rebase and re-verify before merging` };
  }

  // Step 2: merge the computed merge. Where the target is checked out decides
  // whether a plumbing CAS is safe or a coherent in-place ff is required.
  const checkoutDir = await Git.branchCheckedOutAt(repoDir, baseBranch);

  if (checkoutDir === null) {
    // Nobody has the target checked out — a CAS ref-update is safe and cannot
    // desync any working tree. Fails cleanly if the target moved meanwhile.
    const cas = await Git.casUpdateRef(repoDir, baseBranch, newOid, expectedOld);
    if (!cas.ok) return { ok: false, reason: 'target-advanced', detail: cas.detail ?? 'target ref advanced since merging began' };
    return { ok: true, mode: 'cas', oid: newOid, baseBranch, branch };
  }

  // The target is checked out. A plumbing ref-update would desync it, so merge
  // only under the merge mutex with a coherent checkout/reset.
  if (!args.mutexHeld) {
    return { ok: false, reason: 'fallback-pr-manual', detail: `target branch '${baseBranch}' is checked out and the merge mutex is not held; merge via PR/manual` };
  }
  if (await Git.isDirty(checkoutDir)) {
    return { ok: false, reason: 'fallback-pr-manual', detail: `target branch '${baseBranch}' checkout has uncommitted changes; merge via PR/manual` };
  }
  // Coherent merge: `merge --ff-only` advances the branch ref and the working
  // tree together, and is itself a CAS (refuses if the tip moved off
  // `expectedOld` — newOid descends from it, so a moved tip is no longer an
  // ancestor and the ff is refused rather than force-resetting the checkout).
  const ff = await Git.ffOnly(checkoutDir, newOid);
  if (!ff.ok) return { ok: false, reason: 'target-advanced', detail: ff.detail ?? 'target ref advanced since merging began' };
  return { ok: true, mode: 'in-place', oid: newOid, baseBranch, branch };
}
