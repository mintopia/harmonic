import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withRepoLock } from './repo-lock.js';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return gitEnv(cwd, {}, ...args);
}

/**
 * Like `git`, but with extra environment variables — the one primitive that
 * needs this is a private `GIT_INDEX_FILE`, so a `read-tree`/`add`/`write-tree`
 * snapshot stages into a throwaway index instead of the workspace's real one
 * (the agent's staging and the operator's checkout are never touched).
 */
async function gitEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return stdout.trim();
  } catch (err: any) {
    // Conflict explanations land on stdout, other failures on stderr.
    const output = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join('\n');
    throw new GitError(`git ${args.join(' ')} failed: ${output || err.message}`, err.stderr ?? '');
  }
}

// Commits made by Harmonic itself (snapshotting a run's work) carry a
// fixed identity so they work without operator git config.
const IDENTITY = ['-c', 'user.name=Harmonic', '-c', 'user.email=harmonic@localhost'];

export const Git = {
  currentBranch: (dir: string) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),

  /** Resolve a revision to its object id (e.g. a branch tip, `HEAD`). */
  revParse: (dir: string, rev: string) => git(dir, 'rev-parse', rev),

  /** Whether the working tree at `dir` has uncommitted changes (tracked,
   * staged, or untracked). Empty `git status --porcelain` output → clean. */
  async isDirty(dir: string): Promise<boolean> {
    return (await git(dir, 'status', '--porcelain')).length > 0;
  },

  /**
   * Capture the full working-tree content of `workspaceDir` (tracked, staged,
   * untracked, and deletions) as a git tree object, relative to `baseRev`, and
   * return its OID. Uses a private throwaway `GIT_INDEX_FILE` seeded from
   * `baseRev` then `add -A`, so neither the workspace's real index nor its
   * checkout is disturbed — the snapshot is hermetic. The tree's blobs/subtrees
   * are written into the shared object store, so they are reachable by a later
   * `commit-tree` in the base repo.
   */
  async writeWorkspaceTree(workspaceDir: string, baseRev: string): Promise<string> {
    const indexDir = mkdtempSync(join(tmpdir(), 'harmonic-idx-'));
    const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
    try {
      await gitEnv(workspaceDir, env, 'read-tree', baseRev);
      await gitEnv(workspaceDir, env, 'add', '-A');
      return await gitEnv(workspaceDir, env, 'write-tree');
    } finally {
      rmSync(indexDir, { recursive: true, force: true });
    }
  },

  /** Create a commit object from a tree + single parent under the fixed
   * Harmonic identity, returning its OID. Writes only an object — moves no
   * ref, touches no branch or checkout. */
  commitTree: (dir: string, treeOid: string, parentOid: string, message: string) =>
    git(dir, ...IDENTITY, 'commit-tree', treeOid, '-p', parentOid, '-m', message),

  /**
   * Create `ref` pointing at `oid`, failing if it already exists — the CAS
   * from empty (`''` old-value = "must not exist"). This is how a candidate is
   * pinned to a private Harmonic ref without ever moving, or racing, the live
   * target branch.
   */
  createRef: (dir: string, ref: string, oid: string) => git(dir, 'update-ref', ref, oid, ''),

  /** Every ref with its object id, one per line — the ref half of a
   * verification fingerprint (a verifier can mutate shared refs via the common
   * git dir, not just tracked files). */
  forEachRef: (dir: string) => git(dir, 'for-each-ref', '--format=%(objectname) %(refname)'),

  /** Add a disposable worktree with a DETACHED HEAD at `oid` — no branch is
   * created or moved, so a verifier sees a stable tree it cannot land. */
  addDetachedWorktree: (dir: string, worktreePath: string, oid: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'add', '--detach', worktreePath, oid)),

  clone: async (repo: string, dest: string): Promise<void> => {
    await execFileAsync('git', ['clone', repo, dest], { maxBuffer: 10 * 1024 * 1024 });
  },

  pull: (dir: string) => git(dir, 'pull', '--ff-only'),

  // worktree create/remove and merge (below) mutate the shared base repo;
  // each runs under a short base-repo lock so concurrent worktree Runs can't
  // corrupt it mid-mutation (issue #121). The lock is scoped to `dir` (the
  // base repo), so Runs on distinct checkouts still parallelise.
  addWorktree: (dir: string, worktreePath: string, newBranch: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'add', '-b', newBranch, worktreePath)),

  removeWorktree: (dir: string, worktreePath: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'remove', '--force', worktreePath)),

  /** Snapshot everything in the worktree onto its branch; no-op when clean. */
  async commitAll(worktreePath: string, message: string): Promise<void> {
    await git(worktreePath, 'add', '-A');
    const status = await git(worktreePath, 'status', '--porcelain');
    if (status.length === 0) return;
    await git(worktreePath, ...IDENTITY, 'commit', '-m', message);
  },

  /**
   * Merge `branch` into `baseBranch` inside `dir` (ADR-0002). On conflict
   * the merge is aborted and { ok: false } returned with git's output.
   */
  async merge(dir: string, baseBranch: string, branch: string): Promise<{ ok: boolean; detail?: string }> {
    return withRepoLock(dir, async () => {
      const current = await Git.currentBranch(dir);
      if (current !== baseBranch) await git(dir, 'checkout', baseBranch);
      try {
        await git(dir, ...IDENTITY, 'merge', '--no-edit', branch);
        return { ok: true };
      } catch (err) {
        const detail = err instanceof GitError ? err.message : String(err);
        try {
          await git(dir, 'merge', '--abort');
        } catch {
          // No merge in progress (e.g. the merge failed before starting).
        }
        return { ok: false, detail };
      }
    });
  },

  /** Diffstat of what the run's branch adds over the merge base. */
  diffStat: (dir: string, baseBranch: string, branch: string) =>
    git(dir, 'diff', '--stat', `${baseBranch}...${branch}`),

  /**
   * Whether `branch` is already merged into `baseBranch` — i.e. `git
   * merge-base --is-ancestor <branch> <baseBranch>` exits 0. Used by
   * crash-recovery (issue #117) to ask the world "is this landing's branch
   * already merged into its base?" without re-running the merge. Never
   * throws: any non-zero exit (including "not an ancestor") resolves
   * `false`.
   */
  async isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean> {
    try {
      await git(dir, 'merge-base', '--is-ancestor', branch, baseBranch);
      return true;
    } catch {
      return false;
    }
  },
};
