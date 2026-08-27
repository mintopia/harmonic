import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GitError } from '../execution/git.js';
import { forEachYielding } from '../reliability/yield.js';

export interface WorktreeOwnerStore {
  listWorktreeOwners(): Promise<readonly { worktreePath: string | null }[]>;
}

export interface RunningRunStore {
  listAllRunning(): Promise<readonly { id: number }[]>;
}

export interface WorktreeRepository {
  listWorktrees(repoDir: string): Promise<readonly WorktreeRecord[]>;
  removeWorktreeAndDeleteBranch(
    repoDir: string,
    worktreePath: string,
    branch: string | null,
    beforeRemove: () => Promise<boolean>,
  ): Promise<boolean>;
}

export interface WorktreeRecord {
  path: string;
  branch: string | null;
}

type WorkspaceSource = () => Promise<readonly { workingDir: string }[]>;

const runWorktreeNames = (runId: number) => [
  `run-${runId}`,
  `verify-${runId}`,
  `cmdverify-${runId}`,
  `critic-${runId}`,
  `critic-reverify-${runId}`,
];

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Reconciles Git's worktree registry against Harmonic's durable owners.
 *
 * Only paths under Harmonic's managed worktree root can be touched. This keeps
 * the primary checkout and operator-created worktrees out of scope even when a
 * Workspace points at the same Git repository. Ownership is snapshotted before
 * Git operations; the Scheduler supplies outer single-flight, while both the
 * repository scan and cleanup pass yield between growing collections.
 */
export class OrphanWorktreeReconciler {
  private readonly managedRoot: string;

  constructor(
    private readonly sessions: WorktreeOwnerStore,
    private readonly runs: RunningRunStore,
    private readonly workspaces: WorkspaceSource,
    private readonly git: WorktreeRepository,
    worktreesDir: string,
    /** Reap the removed worktree's jCodeMunch index (`code-index.ts`), injected
     * so this module stays free of the CLI wrapper and is unit-testable with a
     * spy. Defaults to a no-op; a no-op is also the runtime behaviour when the
     * code-index CLI is absent. */
    private readonly reapIndex: (absPath: string) => Promise<void> = async () => {},
  ) {
    this.managedRoot = resolve(worktreesDir);
  }

  async reconcile(): Promise<{ removed: number }> {
    const ownedPaths = await this.ownedPaths();

    const candidates = new Map<string, { repoDir: string; branch: string | null }>();
    await forEachYielding(await this.workspaces(), async ({ workingDir }) => {
      let worktrees: readonly WorktreeRecord[];
      try {
        worktrees = await this.git.listWorktrees(workingDir);
      } catch (error) {
        // A Workspace may intentionally point at a non-Git directory. That is
        // outside this job's remit, while any other Git failure stays visible
        // through the Scheduler's durable error result.
        if (error instanceof GitError && /not a git repository/i.test(`${error.message}\n${error.stderr}`)) return;
        throw error;
      }
      await forEachYielding(worktrees, async (worktree) => {
        const path = resolve(worktree.path);
        if (isInside(this.managedRoot, path) && !ownedPaths.has(path)) {
          candidates.set(path, { repoDir: workingDir, branch: worktree.branch });
        }
      });
    });

    let removed = 0;
    await forEachYielding(candidates, async ([path, candidate]) => {
      const didRemove = await this.git.removeWorktreeAndDeleteBranch(
        candidate.repoDir,
        path,
        candidate.branch,
        async () => !(await this.ownedPaths()).has(path),
      );
      if (didRemove) {
        removed++;
        await this.reapIndex(path);
      }
    });
    return { removed };
  }

  private async ownedPaths(): Promise<Set<string>> {
    const ownedPaths = new Set<string>();
    await forEachYielding(await this.sessions.listWorktreeOwners(), async (session) => {
      if (session.worktreePath) ownedPaths.add(resolve(session.worktreePath));
    });
    await forEachYielding(await this.runs.listAllRunning(), async (run) => {
      await forEachYielding(runWorktreeNames(run.id), async (name) => {
        ownedPaths.add(resolve(this.managedRoot, name));
      });
    });
    return ownedPaths;
  }
}
