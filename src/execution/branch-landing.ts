import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attributes, SpanContext } from '@opentelemetry/api';
import { Git } from './git.js';
import { startOperation } from '../telemetry/operations.js';

/**
 * Journaled, crash-idempotent branch landing (issue #153, reliability-design
 * Unit D, ADR-0023).
 *
 * "Landing" the `target-ref` effect means advancing a target branch to include
 * a Run's work. The naive way — check the base branch out in the shared repo
 * and `git merge` in place (the pre-#153 `Git.merge`) — mutates whatever
 * checkout happens to be on that branch, so a concurrent operator working tree
 * (or another Run) is silently desynchronised. This module lands **without
 * ever touching a live checkout it isn't explicitly cleared to reset**:
 *
 *  1. The merge is computed in a **dedicated administrative worktree** detached
 *     at the target's current tip — the conflict/abort, if any, happens off to
 *     the side and the live target checkout is never entered.
 *  2. If **no worktree has the target checked out**, the branch ref is advanced
 *     with an **expected-old-OID CAS** ({@link Git.casUpdateRef}): a hand-merge
 *     or another landing that moved the target in between is rejected, not
 *     overwritten.
 *  3. If a worktree **does** have the target checked out (a worktree-mode base
 *     repo sitting on the base branch, or a direct-mode live checkout), a
 *     plumbing ref-update would desync it. So landing happens **only under an
 *     exclusive clean lease** (`leaseHeld` + the checkout being clean) via a
 *     **coherent `merge --ff-only`** that advances the ref and the working tree
 *     together. Absent that lease, or over a dirty checkout, it **falls back to
 *     PR/manual** (`ok:false`, `reason:'fallback-pr-manual'`) rather than risk
 *     the desync — the operator lands it by hand.
 *
 * Idempotent by construction, which is what makes it crash-safe: re-running a
 * land whose branch is already merged is an "Already up to date" no-op (the
 * admin merge leaves HEAD at the base tip, and the CAS / ff-only to that same
 * OID is a no-op success). A crash after the ref moved but before the result
 * was journaled therefore reconciles (issue #115 `reconcile` → `adopt`, or a
 * plain re-invocation) without a duplicate merge or a false conflict.
 *
 * Pure of the database and the Runner, like `candidate.ts` /
 * `execution-isolation.ts`: it takes explicit paths/revisions and calls only
 * `Git.*`, so every branch of the decision is exhaustively testable against a
 * throwaway git repo. The `leaseHeld` gate is the one thing the caller must
 * supply, because whether an exclusive lease is held is a fact about the
 * Runner's world this module deliberately does not reach into.
 */

export interface LandBranchArgs {
  /** The base repo that owns the target ref and the object store. */
  repoDir: string;
  /** The target branch being advanced (a short name, e.g. `main`). */
  baseBranch: string;
  /** The Run's branch whose work is being landed into `baseBranch`. */
  branch: string;
  /**
   * An exclusive clean lease is held over the target checkout, permitting a
   * coherent in-place land of a **checked-out** target. When the target is not
   * checked out this is irrelevant (the CAS ref-update needs no lease). Default
   * `false` — a checked-out target with no asserted lease falls back to
   * PR/manual rather than risk desyncing a checkout this module can't vouch for.
   */
  leaseHeld?: boolean;
  /**
   * Parent directory for the dedicated admin worktree. A fresh unique child of
   * it is created (and removed) per land, so concurrent lands never collide.
   * Defaults to the OS temp dir.
   */
  adminWorktreeParent?: string;
  parent?: SpanContext;
  attributes?: Attributes;
}

/** Best-effort notification after a branch land has succeeded. `repoDir` is
 * the workspace's persistent base repo checkout, never a task checkout. */
export type PostLandHook = (args: Pick<LandBranchArgs, 'repoDir' | 'baseBranch'>) => void | Promise<void>;

/**
 * The repository default the post-land refresh decision compares against: the
 * base repo's live symbolic HEAD — the same convention the whole-Epic land
 * uses (`epic-land-coordinator.ts`). Falls back to the configured
 * `origin/HEAD` only when that checkout is detached (a concurrent direct Run,
 * issue #152); a detached non-clone therefore resolves `null` and no refresh
 * fires, rather than guessing.
 */
export async function resolveRepositoryDefaultBranch(repoDir: string): Promise<string | null> {
  return (await Git.symbolicBranch(repoDir)) ?? Git.defaultBranch(repoDir);
}

/**
 * Build the post-land observer for default-branch advances. The resolver runs
 * against the hook's `repoDir` — the workspace's persistent base repo — never
 * the checkout a direct-mode land happens to run from, so a feature-branch
 * land can't masquerade as a default-branch advance.
 */
export function defaultBranchPostLand(
  refreshAfterDefaultBranchAdvance: (repoDir: string, defaultBranch: string) => Promise<void>,
  resolveDefaultBranch: (repoDir: string) => Promise<string | null> = resolveRepositoryDefaultBranch,
): PostLandHook {
  return async ({ repoDir, baseBranch }) => {
    const defaultBranch = await resolveDefaultBranch(repoDir);
    if (defaultBranch !== baseBranch || defaultBranch === null) return;
    await refreshAfterDefaultBranchAdvance(repoDir, defaultBranch);
  };
}

export type LandBranchOutcome =
  | { ok: true; mode: 'cas' | 'in-place'; oid: string; baseBranch: string; branch: string }
  | { ok: false; reason: 'conflict' | 'target-advanced' | 'fallback-pr-manual'; detail: string };

/** Run the one shared success-only post-land hook around a branch land.
 * `baseRepoDir` is the workspace's persistent base repo checkout, for the
 * direct-mode case where the land's own `repoDir` is a task checkout parked on
 * the task's branch — the hook's default-branch decision must resolve against
 * the former. Omitted, `repoDir` already is the base repo. */
export async function landBranchAndRunPostLand(
  args: LandBranchArgs & { baseRepoDir?: string },
  postLand: PostLandHook | undefined,
  land: (args: LandBranchArgs) => Promise<LandBranchOutcome> = landBranch,
): Promise<LandBranchOutcome> {
  const outcome = await land(args);
  if (outcome.ok) await postLand?.({ repoDir: args.baseRepoDir ?? args.repoDir, baseBranch: args.baseBranch });
  return outcome;
}

/**
 * Land `branch` into `baseBranch` per the module contract. Never throws for an
 * expected landing failure (conflict, a moved target, a missing lease) — those
 * are `{ ok:false }` outcomes the caller journals and surfaces exactly as the
 * pre-#153 merge conflict was; only a genuine git/plumbing fault propagates.
 */
export async function landBranch(args: LandBranchArgs): Promise<LandBranchOutcome> {
  const operation = args.parent
    ? startOperation({ type: 'land', parent: args.parent, attributes: { 'landing.mechanism': 'branch', ...args.attributes } })
    : undefined;
  try {
    const outcome = operation ? await operation.run(() => landBranchUnchecked(args)) : await landBranchUnchecked(args);
    if (outcome.ok) operation?.end();
    else operation?.fail(outcome.detail);
    return outcome;
  } catch (error) {
    operation?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function landBranchUnchecked(args: LandBranchArgs): Promise<LandBranchOutcome> {
  const { repoDir, baseBranch, branch } = args;
  const expectedOld = await Git.revParse(repoDir, baseBranch);

  // Step 1: compute the merge in a dedicated admin worktree detached at the
  // target's current tip. The live target checkout is never entered, so a
  // conflict aborts against a throwaway tree and the base repo stays pristine.
  const parent = mkdtempSync(join(args.adminWorktreeParent ?? tmpdir(), 'harmonic-land-'));
  const adminPath = join(parent, 'admin');
  let newOid: string;
  try {
    await Git.addDetachedWorktree(repoDir, adminPath, expectedOld);
    const merged = await Git.mergeNoEdit(adminPath, branch);
    if (!merged.ok) {
      return { ok: false, reason: 'conflict', detail: merged.detail ?? 'merge conflict' };
    }
    newOid = await Git.revParse(adminPath, 'HEAD');
  } finally {
    await Git.removeWorktree(repoDir, adminPath).catch(() => {});
    rmSync(parent, { recursive: true, force: true });
  }

  // Step 2: land the computed merge. Where the target is checked out decides
  // whether a plumbing CAS is safe or a coherent in-place ff is required.
  const checkoutDir = await Git.branchCheckedOutAt(repoDir, baseBranch);

  if (checkoutDir === null) {
    // Nobody has the target checked out — a CAS ref-update is safe and cannot
    // desync any working tree. Fails cleanly if the target moved meanwhile.
    const cas = await Git.casUpdateRef(repoDir, baseBranch, newOid, expectedOld);
    if (!cas.ok) return { ok: false, reason: 'target-advanced', detail: cas.detail ?? 'target ref advanced since landing began' };
    return { ok: true, mode: 'cas', oid: newOid, baseBranch, branch };
  }

  // The target is checked out. A plumbing ref-update would desync it, so land
  // only under an exclusive clean lease with a coherent checkout/reset.
  if (!args.leaseHeld) {
    return { ok: false, reason: 'fallback-pr-manual', detail: `target branch '${baseBranch}' is checked out and no exclusive lease is held; land via PR/manual` };
  }
  if (await Git.isDirty(checkoutDir)) {
    return { ok: false, reason: 'fallback-pr-manual', detail: `target branch '${baseBranch}' checkout has uncommitted changes; land via PR/manual` };
  }
  // Coherent land: `merge --ff-only` advances the branch ref and the working
  // tree together, and is itself a CAS (refuses if the tip moved off
  // `expectedOld` — newOid descends from it, so a moved tip is no longer an
  // ancestor and the ff is refused rather than force-resetting the checkout).
  const ff = await Git.ffOnly(checkoutDir, newOid);
  if (!ff.ok) return { ok: false, reason: 'target-advanced', detail: ff.detail ?? 'target ref advanced since landing began' };
  return { ok: true, mode: 'in-place', oid: newOid, baseBranch, branch };
}
