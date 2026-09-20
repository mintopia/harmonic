import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRow } from '../db/schema.js';
import type { EpicLifecycle } from '../execution/epic-coordinator.js';
import type { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import type { PostMergeCheckResult, MergePolicyOutcome } from '../execution/merge-policy.js';
import { runCommandVerifierDetached } from '../verification/command-verifier.js';
import type { ResolvedVerifiers } from '../domain/setting-override.js';
import type { MergeEpicIntegration } from './epic-service.js';

export interface EpicIntegrationRunnerDeps {
  workspace: WorkspaceRow;
  worktreesDir?: string | undefined;
  worktrees: EpicWorktreePool;
  epics: EpicLifecycle;
  mergeEpicIntegration: MergeEpicIntegration;
  resolveWorkspaceVerifiers: () => Promise<ResolvedVerifiers>;
}

/** Merges an Epic's integration branch into the default branch under the one merge policy. */
export class EpicIntegrationRunner {
  constructor(private readonly deps: EpicIntegrationRunnerDeps) {}

  async integrate({ repoDir, epicRef, defaultBranch, integrationBranch }: {
    repoDir: string;
    epicRef: number;
    defaultBranch: string;
    integrationBranch: string;
  }): Promise<MergePolicyOutcome> {
    try {
      return await this.deps.mergeEpicIntegration({
        workspaceId: this.deps.workspace.id,
        repoDir,
        epicRef,
        defaultBranch,
        integrationBranch,
        runPostMergeCheck: (mergeOid, baseDir) => this.runPostMergeCheck(epicRef, mergeOid, baseDir),
      });
    } finally {
      await this.deps.worktrees.release(this.deps.workspace.workingDir, epicRef);
    }
  }

  async retire(epicRef: number): Promise<void> {
    await this.deps.worktrees.release(this.deps.workspace.workingDir, epicRef);
    await this.deps.epics.retireIntegrationBranch(epicRef);
  }

  private async runPostMergeCheck(epicRef: number, mergeOid: string, baseDir: string): Promise<PostMergeCheckResult> {
    const stage = (await this.deps.resolveWorkspaceVerifiers()).epic.preMerge;
    for (const command of stage.commands) {
      const attempt = await runCommandVerifierDetached({
        repoDir: baseDir,
        worktreePath: join(this.deps.worktreesDir ?? tmpdir(), `epic-post-merge-${this.deps.workspace.id}-${epicRef}`),
        verifiedHeadOid: mergeOid,
        command,
      });
      if (attempt.verdict !== 'pass') return { pass: false, output: `${attempt.summary}\n${attempt.output}`.trim() };
    }
    return { pass: true, output: '' };
  }
}
