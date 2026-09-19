import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bestEffort } from '../error-handling.js';
import { integrationBranchName } from './epic-coordinator.js';
import { Git } from './git.js';

/**
 * Owns the deterministic `epic-<workspace>-<ref>` worktree checkouts of an
 * integration branch used by whole-Epic verification and post-merge checks.
 * One instance per workspace; the path is deterministic and solely owned by
 * the Epic, so a crash can leave either Git's worktree registration or its
 * directory behind — {@link acquire} reclaims either before retrying.
 */
export class EpicWorktreePool {
  private readonly paths = new Map<number, string>();

  constructor(private readonly deps: { workspaceId: number; worktreesDir?: string | undefined }) {}

  get(epicRef: number): string | undefined {
    return this.paths.get(epicRef);
  }

  async acquire(repoDir: string, epicRef: number): Promise<string> {
    const existing = this.paths.get(epicRef);
    if (existing) return existing;
    const parent = this.deps.worktreesDir ?? tmpdir();
    mkdirSync(parent, { recursive: true });
    const path = join(parent, `epic-${this.deps.workspaceId}-${epicRef}`);
    try {
      await Git.addWorktreeCheckout(repoDir, path, integrationBranchName(epicRef));
    } catch {
      await Git.removeWorktree(repoDir, path).catch(() => rmSync(path, { recursive: true, force: true }));
      await Git.addWorktreeCheckout(repoDir, path, integrationBranchName(epicRef));
    }
    this.paths.set(epicRef, path);
    return path;
  }

  async release(repoDir: string, epicRef: number): Promise<void> {
    const worktreePath = this.paths.get(epicRef);
    if (!worktreePath) return;
    this.paths.delete(epicRef);
    await bestEffort(() => Git.removeWorktree(repoDir, worktreePath), {
      op: 'epicWorktreePool.release',
      level: 'debug',
      context: { workspaceId: this.deps.workspaceId, epicRef, worktreePath },
    });
  }
}
