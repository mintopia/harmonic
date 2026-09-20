import type { AppConfig } from '../config.js';
import { isEpicAttempt, type AttemptRow, type EpicAttemptRow, type WorkspaceRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { EpicResolve } from '../execution/epic-coordinator.js';
import type { EpicResolutionDispatch } from './epic-service.js';
import type { EpicVerificationRunner } from './epic-verification-runner.js';

export interface EpicResolutionRunnerDeps {
  workspace: WorkspaceRow;
  getConfig: () => Pick<AppConfig, 'verify' | 'maxAttempts' | 'defaults' | 'harnesses'>;
  epicAttempts: AttemptStore;
  dispatchEpicResolution: EpicResolutionDispatch;
  verification: EpicVerificationRunner;
  onEpicAttemptChanged?: ((attempt: EpicAttemptRow) => void) | undefined;
}

/** Dispatches the resolver against a failed whole-Epic verification, escalating instead once the Epic's Attempt budget is exhausted. */
export class EpicResolutionRunner {
  constructor(private readonly deps: EpicResolutionRunnerDeps) {}

  async resolve({ repoDir, epicRef, title, body, url, verifiedHeadOid, verification, guidance, continuationSessionId, continuationSessionRowId }: Parameters<EpicResolve>[0]): Promise<void> {
    const { workspace, getConfig, epicAttempts, dispatchEpicResolution } = this.deps;
    const attempt = this.deps.verification.getTrackedAttempt(epicRef) ?? await epicAttempts.getRunningForEpic({ workspaceId: workspace.id, epicRef });
    if (!attempt) throw new Error(`Epic #${epicRef} has no running Attempt to resolve`);
    const maxAttempts = workspace.maxAttempts ?? getConfig().maxAttempts;
    if (!attempt.feedback && attempt.number >= maxAttempts) {
      await this.settleEpicAttempt(attempt.id, 'escalated', 'epic-verification', `Epic verification failed after ${maxAttempts} Attempt${maxAttempts === 1 ? '' : 's'}: ${verification.reason}`, verifiedHeadOid);
      throw new Error(`Epic verification exhausted its ${maxAttempts}-Attempt limit: ${verification.reason}`);
    }
    try {
      const worktreePath = this.deps.verification.worktreePath(epicRef);
      if (!worktreePath) throw new Error(`Epic #${epicRef} has no verification worktree to resolve`);
      await dispatchEpicResolution({
        workspaceId: workspace.id,
        epicRef,
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        ...(url ? { url } : {}),
        repoDir,
        worktreePath,
        attempt,
        verifiedHeadOid,
        verificationReason: guidance ? `${verification.reason}\n\n## Operator guidance\n${guidance}` : verification.reason,
        resolvePrompt: getConfig().verify.epic.resolvePrompt,
        ...(continuationSessionId && continuationSessionRowId !== undefined ? { continuationSessionId, continuationSessionRowId } : {}),
      });
      await this.settleEpicAttempt(attempt.id, 'failed', 'epic-verification', verification.reason, verifiedHeadOid);
    } catch (error) {
      await this.settleEpicAttempt(attempt.id, 'escalated', 'epic-resolution', error instanceof Error ? error.message : String(error), verifiedHeadOid);
      throw error;
    } finally {
      this.deps.verification.clearTrackedAttempt(epicRef);
    }
  }

  private async settleEpicAttempt(id: number, state: AttemptRow['state'], reason: string, detail: string, verifiedHeadOid: string): Promise<void> {
    this.publishEpicAttempt(await this.deps.epicAttempts.updateWithFrozenCost(id, { state, reason, detail, endedAt: Date.now(), verifiedHeadOid }));
  }

  private publishEpicAttempt(attempt: AttemptRow): void {
    if (isEpicAttempt(attempt)) this.deps.onEpicAttemptChanged?.(attempt);
  }
}
