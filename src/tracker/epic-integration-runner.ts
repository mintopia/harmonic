import type { WorkspaceRow } from '../db/schema.js';
import type { EpicLifecycle } from '../execution/epic-coordinator.js';
import type { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import type { PostMergeCheckResult, MergePolicyOutcome } from '../execution/merge-policy.js';
import { runCommandVerifier } from '../verification/command-verifier.js';
import type { ResolvedVerifiers } from '../domain/setting-override.js';
import type { MergeEpicIntegration } from './epic-service.js';

export interface EpicIntegrationRunnerDeps {
  workspace: Pick<WorkspaceRow, 'id' | 'workingDir'>;
  worktrees: Pick<EpicWorktreePool, 'release'>;
  epics: Pick<EpicLifecycle, 'retireIntegrationBranch'>;
  mergeEpicIntegration: MergeEpicIntegration;
  resolvePostMergeCommands: () => Promise<ResolvedVerifiers['epic']['preMerge']['commands']>;
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
        runPostMergeCheck: (mergeOid, baseDir) => this.runPostMergeCheck(mergeOid, baseDir),
      });
    } finally {
      await this.deps.worktrees.release(this.deps.workspace.workingDir, epicRef);
    }
  }

  async retire(epicRef: number): Promise<void> {
    await this.deps.worktrees.release(this.deps.workspace.workingDir, epicRef);
    await this.deps.epics.retireIntegrationBranch(epicRef);
  }

  private async runPostMergeCheck(mergeOid: string, baseDir: string): Promise<PostMergeCheckResult> {
    const commands = await this.deps.resolvePostMergeCommands();
    for (const command of commands) {
      const attempt = await runCommandVerifier({
        cwd: baseDir,
        verifiedHeadOid: mergeOid,
        command,
      });
      if (attempt.verdict !== 'pass') return { pass: false, output: `${attempt.summary}\n${attempt.output}`.trim() };
    }
    return { pass: true, output: '' };
  }
}
