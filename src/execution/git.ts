import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Attributes } from '@opentelemetry/api';
import { withRepoLock } from './repo-lock.js';
import { startActiveChildOperation } from '../telemetry/operations.js';
import { forEachYielding } from '../reliability/yield.js';
import { logger } from '../logger.js';
import { GitError } from '../domain/errors.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

const CLONE_TIMEOUT_MS = 600_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitEnv(cwd, {}, ...args);
}

async function gitEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return stdout.trim();
  } catch (err: any) {
    // Conflict explanations merge on stdout, other failures on stderr.
    const output = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join('\n');
    throw new GitError(`git ${args.join(' ')} failed: ${output || err.message}`, err.stderr ?? '');
  }
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitFailure(result: unknown): result is { ok: false; detail?: unknown } {
  return typeof result === 'object' && result !== null && 'ok' in result && result.ok === false;
}

async function withGitOperation<T>(
  type: string,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> {
  const operation = startActiveChildOperation(type, attributes);
  if (!operation) return work();
  try {
    const result = await work();
    if (isGitFailure(result)) {
      const reason = typeof result.detail === 'string' ? result.detail : 'git operation failed';
      operation.update({ 'git.result': 'error' });
      operation.fail(reason);
    } else {
      operation.update({ 'git.result': 'ok' });
      operation.end();
    }
    return result;
  } catch (error) {
    const reason = failureReason(error);
    operation.update({ 'git.result': 'error' });
    operation.fail(reason);
    throw error;
  }
}

// git refuses to commit without user.name/user.email configured.
const IDENTITY = ['-c', 'user.name=Harmonic', '-c', 'user.email=harmonic@localhost'];

// `merge-tree --write-tree` needs git >= 2.38; on an older git the flag is
// unknown and every call errors, which would look like a merge conflict.
let warnedMergeTreeUnsupported = false;
function warnOnceIfMergeTreeUnsupported(err: unknown): void {
  if (warnedMergeTreeUnsupported) return;
  const msg = String((err as { message?: string })?.message ?? err);
  if (!/write-tree/.test(msg)) return;
  if (!/unknown option|unknown switch|usage:|not a git command/i.test(msg)) return;
  warnedMergeTreeUnsupported = true;
  process.emitWarning(
    'git is older than 2.38 (no `merge-tree --write-tree`): epic-merge tier-2 ' +
      'squash/rebase containment detection is disabled; upgrade git to restore it (#218).',
    { code: 'HARMONIC_GIT_TOO_OLD' },
  );
}

export const Git = {
  currentBranch: (dir: string) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),

  /** Resolve a revision to its object id (e.g. a branch tip, `HEAD`). */
  revParse: (dir: string, rev: string) => git(dir, 'rev-parse', rev),

  /** Rejects with the git error when `dir` is not a repository with a resolvable `HEAD`. */
  assertRepo: async (dir: string): Promise<void> => {
    await git(dir, 'rev-parse', 'HEAD');
  },

  /** Whether the working tree at `dir` has uncommitted changes (tracked,
   * staged, or untracked). Empty `git status --porcelain` output → clean. */
  async isDirty(dir: string): Promise<boolean> {
    return (await git(dir, 'status', '--porcelain')).length > 0;
  },

  /**
   * The symbolic branch HEAD points at, or `null` on a detached HEAD. Unlike
   * {@link currentBranch} (`--abbrev-ref`, which returns the literal `HEAD` when
   * detached), this never mis-reports a detached HEAD as a branch named "HEAD".
   * `symbolic-ref -q` exits non-zero (→ GitError) when HEAD is detached.
   */
  async symbolicBranch(dir: string): Promise<string | null> {
    try {
      return await git(dir, 'symbolic-ref', '--short', '-q', 'HEAD');
    } catch {
      return null;
    }
  },

  /**
   * The repository's configured default branch, independent of which branch a
   * worktree currently has checked out. `refs/remotes/origin/HEAD` remains
   * readable while the checkout is detached or parked on a task branch.
   */
  async defaultBranch(dir: string): Promise<string | null> {
    try {
      const remoteHead = await git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
      return remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : remoteHead;
    } catch {
      return null;
    }
  },

  /**
   * A stable fingerprint of the working tree's dirty state — the sha256 of the
   * porcelain status. A clean tree yields a fixed constant; any tracked, staged,
   * or untracked change moves it.
   */
  async statusFingerprint(dir: string): Promise<string> {
    const status = await git(dir, 'status', '--porcelain');
    return createHash('sha256').update(status).digest('hex');
  },

  /** The absolute repo root (`--show-toplevel`). Throws when `dir` is not a git repo. */
  toplevel: (dir: string) => git(dir, 'rev-parse', '--show-toplevel'),

  /** The `origin` remote URL, or null when no origin is configured. */
  async originUrl(dir: string): Promise<string | null> {
    try {
      return await git(dir, 'remote', 'get-url', 'origin');
    } catch {
      return null;
    }
  },

  /**
   * Whether the repo at `dir` declares git submodules — either a tracked gitlink
   * (mode `160000` in the index) or a `.gitmodules` file.
   */
  async hasSubmodules(dir: string): Promise<boolean> {
    const staged = await git(dir, 'ls-files', '--stage');
    if (staged.split('\n').some((line) => line.startsWith('160000'))) return true;
    return existsSync(join(dir, '.gitmodules'));
  },

  /**
   * Whether the working tree at `dir` contains a nested git repository — an
   * independent repo checked out inside the tree (not a submodule). git does not
   * recurse into it, so it appears to the outer repo as a single untracked
   * directory whose own `.git` is the tell. Bounded to fully-untracked top-level
   * directory entries (`--directory` collapses them).
   */
  async hasNestedRepos(dir: string): Promise<boolean> {
    const untracked = await git(dir, 'ls-files', '--others', '--exclude-standard', '--directory');
    for (const entry of untracked.split('\n')) {
      if (!entry.endsWith('/')) continue;
      if (existsSync(join(dir, entry, '.git'))) return true;
    }
    return false;
  },

  /** Create a commit object from a tree + single parent under the fixed
   * Harmonic identity, returning its OID. Writes only an object — moves no
   * ref, touches no branch or checkout. */
  commitTree: (dir: string, treeOid: string, parentOid: string, message: string) =>
    git(dir, ...IDENTITY, 'commit-tree', treeOid, '-p', parentOid, '-m', message),

  /**
   * Create `ref` pointing at `oid`, failing if it already exists — the CAS
   * from empty (`''` old-value = "must not exist").
   */
  createRef: (dir: string, ref: string, oid: string) => git(dir, 'update-ref', ref, oid, ''),

  /** Set `ref` to `oid` unconditionally (no old-value CAS). */
  setRef: (dir: string, ref: string, oid: string) => git(dir, 'update-ref', ref, oid),

  /** Add a disposable worktree with a DETACHED HEAD at `oid` — no branch is
   * created or moved, so a verifier sees a stable tree it cannot merge. */
  addDetachedWorktree: (dir: string, worktreePath: string, oid: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'add', '--detach', worktreePath, oid)),

  /**
   * Detach HEAD at `oid` in `dir`'s own working tree, force-discarding any
   * working-tree changes (`-f`). While detached, an agent `git commit` /
   * `reset` / `checkout -B` moves only HEAD, so the branch HEAD was on cannot
   * advance. Takes no base-repo lock.
   */
  checkoutDetach: (dir: string, oid: string) => git(dir, 'checkout', '-f', '--detach', oid),

  /**
   * Re-attach HEAD to `branch` and reset the tracked working tree/index to it,
   * force-discarding tracked changes (`-f`). Untracked files are removed
   * separately via {@link cleanUntracked}.
   */
  checkoutForce: (dir: string, branch: string) => git(dir, 'checkout', '-f', branch),

  /**
   * Check `branch` out at `dir` WITHOUT `-f`: git refuses (throws) rather than
   * overwrite uncommitted local changes.
   */
  checkout: (dir: string, branch: string) =>
    withGitOperation('git.checkout', { 'git.branch': branch }, async () => git(dir, 'checkout', branch)),

  /**
   * Re-point HEAD at `branch` with a metadata-only `symbolic-ref` — no checkout,
   * no index or working-tree write. Coherent ONLY when the working tree already
   * matches `branch`'s tip (the caller's responsibility). Because it never
   * touches the index it succeeds where a contended `checkout -f` fails.
   */
  reattachHead: (dir: string, branch: string) => git(dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`),

  /**
   * Remove untracked files and directories (`clean -fd`), leaving ignored files
   * (no `-x`) untouched.
   */
  cleanUntracked: (dir: string) => git(dir, 'clean', '-fd'),

  clone: async (repo: string, dest: string): Promise<void> => {
    await execFileAsync('git', ['clone', repo, dest], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: CLONE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  },

  pull: (dir: string) => git(dir, 'pull', '--ff-only'),

  /**
   * Whether local branch `name` exists. Never throws: `show-ref --verify
   * --quiet` exits non-zero when the ref is absent.
   */
  async branchExists(dir: string, name: string): Promise<boolean> {
    try {
      await git(dir, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Create local branch `name` at `startPoint` WITHOUT checking it out. Fails
   * if the branch already exists; callers guard with {@link branchExists}.
   * Takes the base-repo lock.
   */
  createBranch: (dir: string, name: string, startPoint: string) =>
    withGitOperation('git.branch-cut', { 'git.branch': name, 'git.ref': startPoint }, () =>
      withRepoLock(dir, () => git(dir, 'branch', name, startPoint)),
    ),

  /** Delete local branch `name` (`-D`, force). Under the base-repo lock. */
  deleteBranch: (dir: string, name: string) =>
    withRepoLock(dir, () => git(dir, 'branch', '-D', name)),

  /**
   * Add a worktree on new branch `newBranch`, under the base-repo lock (scoped
   * to `dir`). `startPoint` is where `newBranch` forks from; omitted, git forks
   * from the base repo's current HEAD. A start-point that is not checked out is
   * fine: git never moves the base repo's own HEAD.
   */
  addWorktree: (dir: string, worktreePath: string, newBranch: string, startPoint?: string) =>
    withGitOperation('git.branch-cut', { 'git.branch': newBranch, 'git.ref': startPoint ?? 'HEAD' }, () =>
      withRepoLock(dir, () =>
        git(dir, 'worktree', 'add', '-b', newBranch, worktreePath, ...(startPoint ? [startPoint] : [])),
      ),
    ),

  /**
   * Add a worktree that checks out an EXISTING branch (no `-b`);
   * {@link addWorktree}'s create-only `-b` form would fail on an existing branch.
   */
  addWorktreeCheckout: (dir: string, worktreePath: string, branch: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'add', worktreePath, branch)),

  removeWorktree: (dir: string, worktreePath: string) =>
    withRepoLock(dir, async () => {
      await git(dir, 'worktree', 'remove', '--force', worktreePath);
      // `git worktree remove` drops a worktree whose registration git considers
      // broken while leaving its directory behind.
      rmSync(worktreePath, { recursive: true, force: true });
    }),

  /**
   * Whether `worktreePath` is a live, registered git worktree of the base repo
   * at `dir`. True requires BOTH that git resolves a work tree rooted *at* the
   * path — not a parent repository it walked up into — AND that the path is in
   * the base repo's `worktree list`. A directory that exists on disk but was
   * deregistered (its `.git` gitlink or backing admin dir gone) is false.
   */
  async isValidWorktree(dir: string, worktreePath: string): Promise<boolean> {
    if (!existsSync(worktreePath)) return false;
    let top: string;
    try {
      top = await git(worktreePath, 'rev-parse', '--show-toplevel');
    } catch {
      return false;
    }
    const target = realpathSync(worktreePath);
    if (realpathSync(top) !== target) return false;
    const registered = await Git.listWorktrees(dir);
    return registered.some((w) => existsSync(w.path) && realpathSync(w.path) === target);
  },

  /**
   * Clear a worktree directory that is no longer a live git worktree — present
   * on disk but deregistered — so the path is free for a fresh
   * {@link addWorktree}. `worktree remove` can't do this: git refuses to act on
   * a path it no longer tracks.
   */
  discardOrphanWorktree: (dir: string, worktreePath: string) =>
    withRepoLock(dir, async () => {
      rmSync(worktreePath, { recursive: true, force: true });
      await git(dir, 'worktree', 'prune');
    }),

  /**
   * Remove an orphaned worktree and the branch that was checked out there as
   * one repository-locked operation. `worktree remove` must happen first:
   * Git refuses to delete a branch while a worktree still checks it out.
   */
  removeWorktreeAndDeleteBranch: (
    dir: string,
    worktreePath: string,
    branch: string | null,
    beforeRemove: () => Promise<boolean>,
  ) =>
    withRepoLock(dir, async () => {
      if (!(await beforeRemove())) return false;
      await git(dir, 'worktree', 'remove', '--force', worktreePath);
      if (branch?.startsWith('harmonic/')) await git(dir, 'branch', '-D', branch);
      return true;
    }),

  /**
   * List Git's registered worktrees and their checked-out local branches.
   * Detached worktrees carry `branch: null`.
   */
  async listWorktrees(dir: string): Promise<Array<{ path: string; branch: string | null }>> {
    return withRepoLock(dir, async () => {
      const entries: Array<{ path: string; branch: string | null }> = [];
      let current: { path: string; branch: string | null } | undefined;
      await forEachYielding((await git(dir, 'worktree', 'list', '--porcelain')).split('\n'), async (line) => {
        if (line.startsWith('worktree ')) {
          if (current) entries.push(current);
          current = { path: line.slice('worktree '.length), branch: null };
        } else if (line.startsWith('branch refs/heads/') && current) {
          current.branch = line.slice('branch refs/heads/'.length);
        }
      });
      if (current) entries.push(current);
      return entries;
    });
  },

  /** Snapshot everything in the worktree onto its branch; no-op when clean. */
  async commitAll(worktreePath: string, message: string): Promise<void> {
    await git(worktreePath, 'add', '-A');
    const status = await git(worktreePath, 'status', '--porcelain');
    if (status.length === 0) return;
    await git(worktreePath, ...IDENTITY, 'commit', '-m', message);
  },

  /** Diffstat of what the run's branch adds over the merge base. */
  diffStat: (dir: string, baseBranch: string, branch: string) =>
    git(dir, 'diff', '--stat', `${baseBranch}...${branch}`),

  /** The shared ancestor Git uses for a three-dot diff range. */
  mergeBase: (dir: string, base: string, head: string) => git(dir, 'merge-base', base, head),

  /** Full unified diff of what the run's branch adds over the merge base — the
   * same `baseBranch...branch` range {@link diffStat} counts, so a parsed
   * per-file hunk view and the diffstat agree. */
  diffUnified: (dir: string, baseBranch: string, branch: string) =>
    git(dir, 'diff', `${baseBranch}...${branch}`),

  /**
   * The full unified diff `oid` adds over `base`, computed straight from the
   * object store (`base..oid`, not the three-dot merge-base form `diffStat`
   * uses), so a `base` that has since moved doesn't change the result. Works
   * against any two revisions reachable in `dir`'s object store — no checkout
   * required.
   */
  diffRange: (dir: string, base: string, oid: string) => git(dir, 'diff', `${base}..${oid}`),

  /** The frozen whole-Epic diff from an integration merge commit:
   * `git diff <M>^1 <M>^2` — first parent (base-before) against second (epic-tip).
   * Reads the merge commit's own parents straight from the object store — no
   * branch or checkout required. */
  diffMergeCommit: (dir: string, mergeOid: string) => git(dir, 'diff', `${mergeOid}^1`, `${mergeOid}^2`),

  /**
   * Diffstat of a live worktree's current state — committed AND uncommitted
   * tracked changes — against `baseOid` (the fork point). `--no-optional-locks`
   * so a read never contends with the agent's index writes. Untracked
   * (never-added) files are not included, exactly as `git diff <commit>` omits
   * them.
   */
  worktreeDiffStat: (worktreeDir: string, baseOid: string) =>
    git(worktreeDir, '--no-optional-locks', 'diff', '--stat', baseOid),

  /** Full unified diff of a live worktree's current state (committed + uncommitted
   * tracked changes) against `baseOid`. The hunk-level companion to
   * {@link worktreeDiffStat}; same read-only, lock-free contract. */
  worktreeDiffUnified: (worktreeDir: string, baseOid: string) =>
    git(worktreeDir, '--no-optional-locks', 'diff', baseOid),

  /**
   * Whether `branch` is already merged into `baseBranch` — i.e. `git
   * merge-base --is-ancestor <branch> <baseBranch>` exits 0. Never throws: any
   * non-zero exit (including "not an ancestor") resolves `false`.
   */
  async isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean> {
    try {
      await git(dir, 'merge-base', '--is-ancestor', branch, baseBranch);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Count of commits on `tip` that are not on `base` (`git rev-list --count
   * <base>..<tip>`). Never throws: an unknown ref or any other git failure
   * resolves 0.
   */
  async commitsAhead(dir: string, base: string, tip: string): Promise<number> {
    try {
      const out = await git(dir, 'rev-list', '--count', `${base}..${tip}`);
      const count = parseInt(out, 10);
      return Number.isFinite(count) ? count : 0;
    } catch {
      return 0;
    }
  },

  /**
   * Whether merging `branch` into `baseBranch` would introduce **no net
   * content** — `branch`'s work is already present in `baseBranch` even when its
   * commits were **squashed or rebased** so the tip is *not* a literal ancestor.
   * A real 3-way merge via `merge-tree --write-tree` yields the merged tree,
   * and the work is contained iff that tree equals `baseBranch`'s own tree. A
   * merge **conflict** makes `merge-tree` exit non-zero — treated as
   * not-contained (`false`). Requires git ≥ 2.38 (`--write-tree`); no checkout
   * or worktree needed. Never throws.
   */
  async isContentContained(dir: string, baseBranch: string, branch: string): Promise<boolean> {
    try {
      const baseTree = (await git(dir, 'rev-parse', `${baseBranch}^{tree}`)).trim();
      // On a clean merge `merge-tree --write-tree` prints the merged tree OID
      // on the first line and exits 0; on conflict it exits non-zero.
      const out = await git(dir, 'merge-tree', '--write-tree', baseBranch, branch);
      const mergedTree = out.split('\n', 1)[0]?.trim() ?? '';
      return mergedTree !== '' && mergedTree === baseTree;
    } catch (err) {
      warnOnceIfMergeTreeUnsupported(err);
      return false;
    }
  },

  /**
   * The absolute path of the worktree that currently has `branch` checked out,
   * or `null` when no worktree does. A detached worktree has no `branch
   * refs/heads/<name>` line in `worktree list --porcelain`, so it never matches.
   */
  async branchCheckedOutAt(dir: string, branch: string): Promise<string | null> {
    const out = await git(dir, 'worktree', 'list', '--porcelain');
    let path: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line === `branch refs/heads/${branch}` && path) return path;
    }
    return null;
  },

  /**
   * Compare-and-swap the branch ref `refs/heads/<branch>` from `expectedOld` to
   * `newOid` (git's own `update-ref <ref> <new> <old>` atomic CAS). Returns
   * `{ ok:false }` (never throws) when the ref no longer points at
   * `expectedOld`. Only ever touches the ref, never a checkout.
   */
  async casUpdateRef(dir: string, branch: string, newOid: string, expectedOld: string): Promise<{ ok: boolean; detail?: string }> {
    try {
      await git(dir, 'update-ref', `refs/heads/${branch}`, newOid, expectedOld);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof GitError ? err.message : String(err) };
    }
  },

  /**
   * Merge `branch` into the worktree at `worktreeDir`'s currently checked-out
   * (or detached) HEAD, returning `{ ok:false }` with git's output on conflict
   * after aborting. Takes no base-repo lock. A fast-forward-able branch
   * fast-forwards, otherwise a merge commit is created — either way HEAD ends
   * at a descendant of the base.
   */
  async mergeNoEdit(worktreeDir: string, branch: string): Promise<{ ok: boolean; detail?: string }> {
    return withGitOperation(
      'git.merge',
      { 'git.branch': branch, 'git.ref': 'HEAD' },
      async () => {
        try {
          await git(worktreeDir, ...IDENTITY, 'merge', '--no-edit', branch);
          return { ok: true };
        } catch (err) {
          const detail = err instanceof GitError ? err.message : String(err);
          try {
            await git(worktreeDir, 'merge', '--abort');
          } catch {
          }
          return { ok: false, detail };
        }
      },
    );
  },

  /**
   * Merge `branch` into the worktree at `worktreeDir`'s checked-out HEAD,
   * LEAVING a conflicted merge in progress (conflict markers + `MERGE_HEAD`)
   * instead of aborting, unlike {@link mergeNoEdit}. A clean merge commits
   * immediately (`--no-edit`) and returns `{ ok: true }`.
   */
  async mergeLeavingConflict(worktreeDir: string, branch: string): Promise<{ ok: boolean; detail?: string }> {
    return withGitOperation(
      'git.merge',
      { 'git.branch': branch, 'git.ref': 'HEAD' },
      async () => {
        try {
          await git(worktreeDir, ...IDENTITY, 'merge', '--no-edit', branch);
          return { ok: true };
        } catch (err) {
          return { ok: false, detail: err instanceof GitError ? err.message : String(err) };
        }
      },
    );
  },

  /**
   * Rebase the branch checked out at `worktreeDir` onto `ontoOid` (linear replay).
   * A conflict (`conflict: true`) is left IN PROGRESS (markers, `REBASE_HEAD`)
   * and returned rather than thrown; any other failure (a missing worktree, a
   * dirty tree) is `conflict: false`, nothing in progress. A rebase an earlier
   * conflict left in progress is aborted first, never resumed. On success the
   * worktree HEAD is the rebased tip (a descendant of `ontoOid`).
   */
  async rebaseOnto(
    worktreeDir: string,
    ontoOid: string,
  ): Promise<{ ok: true; rebasedTip: string } | { ok: false; conflict: boolean; detail: string }> {
    return withGitOperation(
      'git.rebase',
      { 'git.branch': 'HEAD', 'git.ref': ontoOid },
      async () => {
        await git(worktreeDir, 'rebase', '--abort').catch(() => {});
        try {
          await git(worktreeDir, ...IDENTITY, 'rebase', ontoOid);
          const rebasedTip = await Git.revParse(worktreeDir, 'HEAD');
          return { ok: true, rebasedTip };
        } catch (err) {
          const conflict = await git(worktreeDir, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD').then(() => true, () => false);
          return { ok: false, conflict, detail: err instanceof GitError ? err.message : String(err) };
        }
      },
    );
  },

  /**
   * Fast-forward the checkout at `dir` to `oid` (`merge --ff-only`), under the
   * base-repo lock, advancing the branch ref and the working tree together.
   * `--ff-only` is itself a compare-and-swap: it refuses (→ `{ ok:false }`,
   * never throws) unless the current tip is an ancestor of `oid`. No merge
   * state is left behind on refusal, so no abort is needed.
   */
  async ffOnly(dir: string, oid: string): Promise<{ ok: boolean; detail?: string }> {
    return withGitOperation('git.ff-only', { 'git.ref': oid }, () =>
      withRepoLock(dir, async () => {
        try {
          await git(dir, 'merge', '--ff-only', oid);
          return { ok: true };
        } catch (err) {
          return { ok: false, detail: err instanceof GitError ? err.message : String(err) };
        }
      }),
    );
  },

  /**
   * Merge `branch` into `worktreeDir`'s checked-out HEAD, ALWAYS creating a
   * merge commit (`--no-ff`). On a textual conflict the conflicted merge is
   * LEFT IN PROGRESS (markers + `MERGE_HEAD`), mirroring
   * {@link mergeLeavingConflict}'s contract; any other failure (e.g. a dirty
   * tree, nothing to merge) aborts cleanly instead.
   */
  async mergeNoFf(
    worktreeDir: string,
    branch: string,
  ): Promise<{ ok: true; mergeOid: string } | { ok: false; conflict: boolean; detail: string }> {
    return withGitOperation(
      'git.merge',
      { 'git.branch': branch, 'git.ref': 'HEAD' },
      async () => {
        try {
          await git(worktreeDir, ...IDENTITY, 'merge', '--no-ff', '--no-edit', branch);
          return { ok: true, mergeOid: await Git.revParse(worktreeDir, 'HEAD') };
        } catch (err) {
          const detail = err instanceof GitError ? err.message : String(err);
          const conflict = await git(worktreeDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').then(
            () => true,
            () => false,
          );
          if (!conflict) {
            try {
              await git(worktreeDir, 'merge', '--abort');
            } catch {
            }
          }
          return { ok: false, conflict, detail };
        }
      },
    );
  },

  /**
   * Distinct paths git considers unmerged in `worktreeDir`. `ls-files -u`
   * prints one line per stage per conflicted path; deduped down to the paths
   * themselves. Empty once nothing is conflicted.
   */
  async unmergedPaths(worktreeDir: string): Promise<string[]> {
    const out = await git(worktreeDir, 'ls-files', '-u');
    if (out.length === 0) return [];
    const paths = new Set<string>();
    for (const line of out.split('\n')) {
      const path = line.split('\t')[1];
      if (path) paths.add(path);
    }
    return [...paths];
  },

  /**
   * Finalise an in-progress merge once conflicts are resolved and staged
   * (`git commit --no-edit` under the Harmonic identity). Fails (never throws)
   * when unmerged paths remain.
   */
  async completeMerge(worktreeDir: string): Promise<{ ok: true; mergeOid: string } | { ok: false; detail: string }> {
    return withGitOperation('git.merge-complete', { 'git.ref': 'HEAD' }, async () => {
      try {
        await git(worktreeDir, ...IDENTITY, 'commit', '--no-edit');
        return { ok: true, mergeOid: await Git.revParse(worktreeDir, 'HEAD') };
      } catch (err) {
        return { ok: false, detail: err instanceof GitError ? err.message : String(err) };
      }
    });
  },

  /** Abort an in-progress merge, best-effort — there may be none in progress. */
  async abortMerge(worktreeDir: string): Promise<void> {
    return withGitOperation('git.merge-abort', { 'git.ref': 'HEAD' }, async () => {
      logger.debug('git: aborting in-progress merge', { 'git.dir': worktreeDir });
      try {
        await git(worktreeDir, 'merge', '--abort');
      } catch {
      }
    });
  },

  /**
   * Revert merge commit `mergeOid` relative to its first parent (`-m 1`). Lets
   * a `GitError` propagate; there is no fallback if the revert itself fails.
   */
  async revertMergeCommit(worktreeDir: string, mergeOid: string): Promise<string> {
    return withGitOperation('git.revert', { 'git.ref': mergeOid }, async () => {
      await git(worktreeDir, ...IDENTITY, 'revert', '-m', '1', '--no-edit', mergeOid);
      return Git.revParse(worktreeDir, 'HEAD');
    });
  },
};
