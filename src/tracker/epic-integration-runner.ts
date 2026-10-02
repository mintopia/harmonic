import type { WorkspaceRow } from '../db/schema.js';
import type { EpicLifecycle } from '../execution/epic-coordinator.js';
import type { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import type { PostMergeCheckResult, MergePolicyOutcome } from '../execution/merge-policy.js';
import { commandAttemptToInput, type CommandSpawn } from '../verification/command-verifier.js';
import { runPostMergeCommands } from '../verification/post-merge-commands.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { TaskArchive } from '../archive/task-archive.js';
import type { ResolvedVerifiers } from '../domain/setting-override.js';
import type { MergeEpicIntegration } from './epic-service.js';

export interface EpicIntegrationRunnerDeps {
  workspace: Pick<WorkspaceRow, 'id' | 'workingDir'>;
  worktrees: Pick<EpicWorktreePool, 'release'>;
  epics: Pick<EpicLifecycle, 'retireIntegrationBranch'>;
  mergeEpicIntegration: MergeEpicIntegration;
  epicAttempts?: Pick<AttemptStore, 'listForEpic'> | undefined;
  verificationAttemptStore?: Pick<VerificationAttemptStore, 'append'> | undefined;
  archive?: Pick<TaskArchive, 'epicVerificationOutputLog'> | undefined;
  commandSpawn: CommandSpawn;
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
    const { workspace, epicAttempts, verificationAttemptStore, archive } = this.deps;
    const attempt = (await epicAttempts?.listForEpic({ workspaceId: workspace.id, epicRef }))?.at(-1);
    return runPostMergeCommands({
      commands: await this.deps.resolvePostMergeCommands(),
      cwd: baseDir,
      mergeOid,
      commandSpawn: this.deps.commandSpawn,
      outputLog: async (command) =>
        (attempt ? await archive?.epicVerificationOutputLog(workspace.id, epicRef, attempt.number, command.id, 'post-merge') : null) ?? null,
      onAttempt: async (commandAttempt) => {
        if (attempt) await verificationAttemptStore?.append(attempt.id, commandAttemptToInput(commandAttempt));
      },
    });
  }
}
