import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withRepoLock } from './repo-lock.js';
import { forEachYielding } from '../reliability/yield.js';

const execFileAsync = promisify(execFile);

/** Wall-clock ceiling for a single git invocation (issue #199): a hung child is
 * SIGKILLed and reaped rather than lingering as a zombie during an event-loop
 * starvation episode. Two minutes is far beyond any workspace-prep op's real
 * runtime, so a healthy command never hits it. */
const GIT_TIMEOUT_MS = 120_000;

/** Wall-clock ceiling for a `git clone` — far more generous than a
 * workspace-prep op (a large repo over the network is legitimately slow), but a
 * genuinely hung clone is still killed and reaped (issue #199). */
const CLONE_TIMEOUT_MS = 600_000;

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
      // A git child that hangs (e.g. blocked on a lock) is SIGKILLed rather than
      // lingering — so it is reaped deterministically instead of relying on an
      // unblocked event loop to process its exit (issue #199). Well above any
      // real op's turnaround, so a normal command never trips it.
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
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

// `merge-tree --write-tree` (git ≥ 2.38) backs the tier-2 containment check
// (issue #218). On an older git the flag is unknown and the call errors on
// *every* invocation, so the check silently degrades to a no-op. Surface that
// exactly once — a real merge conflict (the expected non-contained result) must
// stay quiet, so only an unsupported-flag/usage error trips the warning.
let warnedMergeTreeUnsupported = false;
function warnOnceIfMergeTreeUnsupported(err: unknown): void {
  if (warnedMergeTreeUnsupported) return;
  const msg = String((err as { message?: string })?.message ?? err);
  if (!/write-tree/.test(msg)) return;
  if (!/unknown option|unknown switch|usage:|not a git command/i.test(msg)) return;
  warnedMergeTreeUnsupported = true;
  process.emitWarning(
    'git is older than 2.38 (no `merge-tree --write-tree`): epic-land tier-2 ' +
      'squash/rebase containment detection is disabled; upgrade git to restore it (#218).',
    { code: 'HARMONIC_GIT_TOO_OLD' },
  );
}

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
   * The symbolic branch HEAD points at, or `null` on a detached HEAD. Unlike
   * {@link currentBranch} (`--abbrev-ref`, which returns the literal `HEAD` when
   * detached), this never mis-reports a detached HEAD as a branch named "HEAD"
   * — issue #149 requires `HEAD` never be recorded as an ordinary branch.
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
   * A stable fingerprint of the working tree's dirty state — the sha256 of the
   * porcelain status. A clean tree yields a fixed constant; any tracked, staged,
   * or untracked change moves it. Recorded at admission (issue #149) as the
   * clean baseline a later branch-contract check compares against.
   */
  async statusFingerprint(dir: string): Promise<string> {
    const status = await git(dir, 'status', '--porcelain');
    return createHash('sha256').update(status).digest('hex');
  },

  /** The absolute repo root (`--show-toplevel`) — the canonical identity of the
   * repo a direct Run runs against (issue #149). Throws when `dir` is not a git
   * repo, so the caller can treat a non-git context as having no start-state. */
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
   * (mode `160000` in the index) or a `.gitmodules` file. Either makes the
   * working tree carry recursive git state Harmonic does not track or attribute
   * (issue #149), so an afk direct Run on such a context is rejected.
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
   * directory entries (`--directory` collapses them), so this stays cheap on a
   * large tree (issue #149).
   */
  async hasNestedRepos(dir: string): Promise<boolean> {
    const untracked = await git(dir, 'ls-files', '--others', '--exclude-standard', '--directory');
    for (const entry of untracked.split('\n')) {
      if (!entry.endsWith('/')) continue; // only a directory can hide a repo
      if (existsSync(join(dir, entry, '.git'))) return true;
    }
    return false;
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

  /**
   * Set `ref` to `oid` unconditionally (no old-value CAS). Used to overwrite a
   * Run's candidate ref when a self-heal turn re-snapshots (issue #137): the
   * ref already exists from the first turn, so the create-only {@link createRef}
   * would fail — the candidate must move to the healed tree the re-verify runs
   * against, or the heal would verify the stale, still-failing candidate.
   */
  setRef: (dir: string, ref: string, oid: string) => git(dir, 'update-ref', ref, oid),

  /** Every ref with its object id, one per line — the ref half of a
   * verification fingerprint (a verifier can mutate shared refs via the common
   * git dir, not just tracked files). */
  forEachRef: (dir: string) => git(dir, 'for-each-ref', '--format=%(objectname) %(refname)'),

  /** Add a disposable worktree with a DETACHED HEAD at `oid` — no branch is
   * created or moved, so a verifier sees a stable tree it cannot land. */
  addDetachedWorktree: (dir: string, worktreePath: string, oid: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'add', '--detach', worktreePath, oid)),

  /**
   * Detach HEAD at `oid` in `dir`'s own working tree, force-discarding any
   * working-tree changes (`-f`). This **parks the branch** HEAD was on: while
   * detached, an agent `git commit` / `reset` / `checkout -B` moves only HEAD,
   * so the live target branch ref cannot advance and expose unverified work on
   * the live branch (reliability-design Unit D, issue #152). Unlike
   * {@link addDetachedWorktree}, this operates on the leased checkout itself
   * (direct mode), not a disposable worktree, so it takes no base-repo lock —
   * the Work Context lease already gives the Run exclusive use of the checkout.
   */
  checkoutDetach: (dir: string, oid: string) => git(dir, 'checkout', '-f', '--detach', oid),

  /**
   * Re-attach HEAD to `branch` and reset the tracked working tree/index to it,
   * force-discarding tracked changes (`-f`). Used to restore the live target
   * checkout coherently at settle (issue #152): the branch never moved while the
   * Run executed detached, so re-checking it out returns HEAD to the live target
   * at its recorded start OID. Untracked files are removed separately via
   * {@link cleanUntracked}.
   */
  checkoutForce: (dir: string, branch: string) => git(dir, 'checkout', '-f', branch),

  /**
   * Re-point HEAD at `branch` with a metadata-only `symbolic-ref` — no checkout,
   * no index or working-tree write. Unlike {@link checkoutForce} this moves NO
   * data, so it is coherent ONLY when the working tree already matches `branch`'s
   * tip (the caller's responsibility). Because it never touches the index it
   * succeeds where a contended `checkout -f` fails — the reattach used to lift a
   * base repo off a bare detached HEAD when HEAD already sits on the branch tip
   * (issue #198).
   */
  reattachHead: (dir: string, branch: string) => git(dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`),

  /**
   * Remove untracked files and directories (`clean -fd`), leaving ignored files
   * (no `-x`) untouched. A coherent restore (issue #152) must match the **clean**
   * context admission (#149) recorded at Run start, so agent-created untracked
   * files are swept — they were already captured hermetically in the candidate.
   * Ignored artifacts (build output, `node_modules`) are deliberately preserved.
   */
  cleanUntracked: (dir: string) => git(dir, 'clean', '-fd'),

  clone: async (repo: string, dest: string): Promise<void> => {
    // A clone can legitimately run for minutes (a large repo over the network),
    // so it gets a far more generous ceiling than a workspace-prep op — but a
    // hung clone is still SIGKILLed and reaped rather than lingering (issue #199).
    await execFileAsync('git', ['clone', repo, dest], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: CLONE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  },

  pull: (dir: string) => git(dir, 'pull', '--ff-only'),

  /**
   * Whether local branch `name` exists (issue #159). Never throws:
   * `show-ref --verify --quiet` exits non-zero when the ref is absent, which is
   * a legitimate "no such branch" answer, not an error — so an Epic integration
   * branch's create/reuse decision reads as a plain boolean.
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
   * Create local branch `name` at `startPoint` WITHOUT checking it out — a bare
   * ref in the shared base repo (issue #159: the Harmonic-owned Epic integration
   * branch, ADR-0023/0024). Member worktrees then fork from it via
   * {@link addWorktree}'s `startPoint`. Fails if the branch already exists;
   * callers guard with {@link branchExists} for idempotent create/reuse. Takes
   * the base-repo lock like the other base-repo mutations below.
   */
  createBranch: (dir: string, name: string, startPoint: string) =>
    withRepoLock(dir, () => git(dir, 'branch', name, startPoint)),

  /**
   * Delete local branch `name` (`-D`, force) — retiring an Epic integration
   * branch once its Epic has landed (issue #159, the retire half of the
   * Harmonic-owned lifecycle). Under the base-repo lock.
   */
  deleteBranch: (dir: string, name: string) =>
    withRepoLock(dir, () => git(dir, 'branch', '-D', name)),

  // worktree create/remove and merge (below) mutate the shared base repo;
  // each runs under a short base-repo lock so concurrent worktree Runs can't
  // corrupt it mid-mutation (issue #121). The lock is scoped to `dir` (the
  // base repo), so Runs on distinct checkouts still parallelise.
  // `startPoint` (a commit-ish — usually the resolved base branch, issue #157)
  // is where `newBranch` forks from. Omitted, git forks from the base repo's
  // current HEAD, preserving today's behaviour. Passing an explicit base branch
  // that is *not* checked out is fine: git reads it as a start-point and never
  // moves or checks out the base repo's own HEAD.
  addWorktree: (dir: string, worktreePath: string, newBranch: string, startPoint?: string) =>
    withRepoLock(dir, () =>
      git(dir, 'worktree', 'add', '-b', newBranch, worktreePath, ...(startPoint ? [startPoint] : [])),
    ),

  /**
   * Add a worktree that checks out an EXISTING branch (no `-b`). A self-heal
   * turn (issue #137) resumes the Run's prior work on its
   * `harmonic/task-<id>-run-<attempt>` branch, which already exists from the
   * first turn's finalize commit — {@link addWorktree}'s create-only `-b` form
   * would fail on it.
   */
  addWorktreeCheckout: (dir: string, worktreePath: string, branch: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'add', worktreePath, branch)),

  removeWorktree: (dir: string, worktreePath: string) =>
    withRepoLock(dir, () => git(dir, 'worktree', 'remove', '--force', worktreePath)),

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
      // Harmonic owns only its namespace. A manually-created worktree could
      // have been placed under the managed directory, but its branch is not
      // ours to delete.
      if (branch?.startsWith('harmonic/')) await git(dir, 'branch', '-D', branch);
      return true;
    }),

  /**
   * List Git's registered worktrees and their checked-out local branches.
   * Detached worktrees deliberately carry `branch: null` and therefore have no
   * branch to prune after cleanup.
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
   * The full unified diff `oid` adds over `base` — the untrusted content a
   * Verification unit (issue #136, ADR-0021) hands to a command or the agent
   * critic. Computed straight from the object store (`base..oid`, not the
   * three-dot merge-base form `diffStat` uses): the critic reviews a frozen
   * candidate against the exact commit it was built on, not a symmetric
   * comparison, so a `base` that has since moved doesn't change what the
   * candidate is judged against. Works against any two revisions reachable
   * in `dir`'s object store — no checkout required.
   */
  diffRange: (dir: string, base: string, oid: string) => git(dir, 'diff', `${base}..${oid}`),

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

  /**
   * Whether merging `branch` into `baseBranch` would introduce **no net
   * content** — `branch`'s work is already present in `baseBranch` even when its
   * commits were **squashed or rebased** so the tip is *not* a literal ancestor
   * (issue #218). Where {@link isAncestor} only catches a fast-forwardable /
   * merge-landed branch, this catches a squash-landed one: a real 3-way merge
   * via `merge-tree --write-tree` yields the merged tree, and the work is
   * contained iff that tree equals `baseBranch`'s own tree (the merge adds
   * nothing). A merge **conflict** (divergent edits) makes `merge-tree` exit
   * non-zero — treated as not-contained (`false`), so the caller falls through
   * to a real land rather than wrongly retiring. Requires git ≥ 2.38
   * (`--write-tree`); no checkout or worktree needed. Never throws.
   */
  async isContentContained(dir: string, baseBranch: string, branch: string): Promise<boolean> {
    try {
      const baseTree = (await git(dir, 'rev-parse', `${baseBranch}^{tree}`)).trim();
      // On a clean merge `merge-tree --write-tree` prints just the merged tree
      // OID on the first line and exits 0; on conflict it exits non-zero (→ the
      // catch below). Compare the merged tree to the base tree.
      const out = await git(dir, 'merge-tree', '--write-tree', baseBranch, branch);
      const mergedTree = out.split('\n', 1)[0]?.trim() ?? '';
      return mergedTree !== '' && mergedTree === baseTree;
    } catch (err) {
      // A conflict (the common, expected outcome) is not-contained → false.
      // But a git older than 2.38 lacks `--write-tree`, so *every* call lands
      // here and the tier-2 storm protection silently no-ops forever. Distinguish
      // that once so a mis-provisioned host is visible in logs rather than
      // degrading in silence (issue #218). Behaviour is unchanged either way.
      warnOnceIfMergeTreeUnsupported(err);
      return false;
    }
  },

  /**
   * The absolute path of the worktree that currently has `branch` checked out,
   * or `null` when no worktree does (issue #153). Landing must never update a
   * target ref out from under a live index/worktree via a plumbing `update-ref`
   * (reliability-design Unit D): this is how a landing tells "the target is
   * checked out — land coherently in place under a lease" from "nobody has it
   * out — a CAS ref-update is safe". Parses `worktree list --porcelain`, whose
   * per-worktree records pair a `worktree <path>` line with a `branch
   * refs/heads/<name>` line (absent on a detached worktree, which is why an
   * admin/verification worktree is never mistaken for the live target).
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
   * `newOid` (issue #153) — git's own `update-ref <ref> <new> <old>` atomic CAS,
   * the reliability-design Unit D "expected-old-OID CAS". Returns `{ ok:false }`
   * (never throws) when the ref no longer points at `expectedOld` — a hand-merge
   * or another landing that advanced the target in between is rejected instead
   * of being silently overwritten. Only ever touches the ref, never a checkout,
   * so it is used exclusively on a target that no worktree has checked out.
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
   * after aborting (issue #153). Unlike {@link merge} this neither takes the
   * base-repo lock nor checks out a base branch — the caller has already placed
   * a **dedicated admin worktree** at the expected base OID, so this only writes
   * objects + that admin worktree's own index. `--no-edit` matches {@link merge}
   * / ADR-0002; a fast-forward-able branch fast-forwards, otherwise a merge
   * commit is created — either way HEAD ends at a descendant of the base.
   */
  async mergeNoEdit(worktreeDir: string, branch: string): Promise<{ ok: boolean; detail?: string }> {
    try {
      await git(worktreeDir, ...IDENTITY, 'merge', '--no-edit', branch);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof GitError ? err.message : String(err);
      try {
        await git(worktreeDir, 'merge', '--abort');
      } catch {
        // No merge in progress (e.g. it failed before starting).
      }
      return { ok: false, detail };
    }
  },

  /**
   * Rebase the branch checked out at `worktreeDir` onto `ontoOid` (linear replay).
   * On conflict, aborts (`git rebase --abort`) so the worktree is left clean for
   * the member Session's bounded corrective turn, and returns the conflict signal
   * rather than throwing — same contract as {@link mergeNoEdit}. On success the
   * worktree HEAD is the rebased tip (a descendant of `ontoOid`).
   */
  async rebaseOnto(
    worktreeDir: string,
    ontoOid: string,
  ): Promise<{ ok: true; rebasedTip: string } | { ok: false; conflict: true; detail: string }> {
    try {
      await git(worktreeDir, ...IDENTITY, 'rebase', ontoOid);
      const rebasedTip = await Git.revParse(worktreeDir, 'HEAD');
      return { ok: true, rebasedTip };
    } catch (err) {
      const detail = err instanceof GitError ? err.message : String(err);
      try {
        await git(worktreeDir, 'rebase', '--abort');
      } catch {
        // No rebase in progress (e.g. it failed before starting).
      }
      return { ok: false, conflict: true, detail };
    }
  },

  /**
   * Fast-forward the checkout at `dir` to `oid` (`merge --ff-only`), under the
   * base-repo lock (issue #153) — the **coherent checkout/reset** a checked-out
   * target lands through (reliability-design Unit D), advancing the branch ref
   * and the working tree together rather than a desyncing plumbing ref-update.
   * `--ff-only` is itself a compare-and-swap: it refuses (→ `{ ok:false }`,
   * never throws) unless the current tip is an ancestor of `oid`, so a target
   * that moved since the admin-worktree merge was computed fails safely instead
   * of being force-reset over. No merge state is left behind on refusal, so no
   * abort is needed.
   */
  async ffOnly(dir: string, oid: string): Promise<{ ok: boolean; detail?: string }> {
    return withRepoLock(dir, async () => {
      try {
        await git(dir, 'merge', '--ff-only', oid);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof GitError ? err.message : String(err) };
      }
    });
  },
};
