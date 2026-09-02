import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import { Git } from './git.js';
import { startOperation } from '../telemetry/operations.js';

export interface MergeIntoBaseArgs {
  /** The base repo that owns the target ref and the object store. */
  repoDir: string;
  /** The target branch being advanced (a short name, e.g. `main`). */
  baseBranch: string;
  /** The Attempt's branch whose work is being merged into `baseBranch`. */
  branch: string;
  /** Exact branch tip verified for this merging. The merge consumes this OID,
   * never a later resolution of `branch`. */
  expectedOid: string;
  /** `'fast-forward'` (default) merges only a tip that already contains the
   * base's current tip — verification saw exactly the merged tree; a base that
   * advanced since is refused as `stale-base`. `'merge'` folds a diverged base
   * in with a merge commit: integration-branch refreshes, where the "branch" is
   * the default branch being merged into `epic/<ref>`. */
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
 * The base repo's live symbolic HEAD, falling back to the configured
 * `origin/HEAD` when that checkout is detached; `null` when neither resolves.
 */
export async function resolveRepositoryDefaultBranch(repoDir: string): Promise<string | null> {
  return (await Git.symbolicBranch(repoDir)) ?? Git.defaultBranch(repoDir);
}

/**
 * Build the post-merge observer for default-branch advances. The resolver runs
 * against the hook's `repoDir` — the workspace's persistent base repo — never
 * the checkout a direct-mode merge happens to run from.
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
 * Merge `branch` into `baseBranch`. Never throws for an expected merging
 * failure (conflict, a moved target, the mutex not held) — those are
 * `{ ok:false }` outcomes; only a genuine git/plumbing fault propagates.
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
  const branchOid = await Git.revParse(repoDir, branch).catch(() => null);
  if (branchOid !== expectedOid) {
    return { ok: false, reason: 'stale-head', detail: `branch '${branch}' moved after verification` };
  }
  const expectedOld = await Git.revParse(repoDir, baseBranch);

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
    newOid = expectedOid;
  } else {
    return { ok: false, reason: 'stale-base', detail: `base '${baseBranch}' advanced after verification; rebase and re-verify before merging` };
  }

  const checkoutDir = await Git.branchCheckedOutAt(repoDir, baseBranch);

  if (checkoutDir === null) {
    const cas = await Git.casUpdateRef(repoDir, baseBranch, newOid, expectedOld);
    if (!cas.ok) return { ok: false, reason: 'target-advanced', detail: cas.detail ?? 'target ref advanced since merging began' };
    return { ok: true, mode: 'cas', oid: newOid, baseBranch, branch };
  }

  if (!args.mutexHeld) {
    return { ok: false, reason: 'fallback-pr-manual', detail: `target branch '${baseBranch}' is checked out and the merge mutex is not held; merge via PR/manual` };
  }
  if (await Git.isDirty(checkoutDir)) {
    return { ok: false, reason: 'fallback-pr-manual', detail: `target branch '${baseBranch}' checkout has uncommitted changes; merge via PR/manual` };
  }
  // git `merge --ff-only` is itself a CAS: it refuses when the checked-out tip
  // moved off `expectedOld`, so a moved tip is never force-reset.
  const ff = await Git.ffOnly(checkoutDir, newOid);
  if (!ff.ok) return { ok: false, reason: 'target-advanced', detail: ff.detail ?? 'target ref advanced since merging began' };
  return { ok: true, mode: 'in-place', oid: newOid, baseBranch, branch };
}
