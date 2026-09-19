import type { AppConfig } from '../config.js';
import { isEpicAttempt, type AttemptRow, type EpicAttemptRow, type WorkspaceRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { pricesForHarness, withCriticContribution } from '../domain/pricing.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { resolveRepositoryDefaultBranch } from '../execution/branch-merge.js';
import { integrationBranchName } from '../execution/epic-coordinator.js';
import type { EpicWorktreePool } from '../execution/epic-worktree-pool.js';
import { verifyEpicIntegration } from '../execution/epic-verification.js';
import { Git } from '../execution/git.js';
import { collectUsage } from '../execution/usage.js';
import { commandAttemptToInput, type CommandAttempt } from '../verification/command-verifier.js';
import { criticAttemptToInput, runCritic, type CriticHarnessDrive } from '../verification/critic.js';
import type { EpicVerificationStage } from '../config.js';
import type { VerificationDecision, VerifierVerdict } from '../verification/combine.js';

export interface EpicVerificationRunnerDeps {
  workspace: WorkspaceRow;
  getWorkspaces: () => Promise<WorkspaceRow[]>;
  getConfig: () => Pick<AppConfig, 'verify' | 'maxAttempts' | 'defaults' | 'harnesses'>;
  worktrees: EpicWorktreePool;
  epicAttempts?: AttemptStore | undefined;
  verificationAttemptStore?: VerificationAttemptStore | undefined;
  onEpicAttemptChanged?: ((attempt: EpicAttemptRow) => void) | undefined;
  criticDrive?: CriticHarnessDrive | undefined;
}

/**
 * Runs whole-Epic pre-merge verification against a checked-out integration
 * branch tip, recording an Epic Attempt (with per-command and per-critic
 * steps) when Attempt tracking is configured.
 */
export class EpicVerificationRunner {
  private readonly runningAttempts = new Map<number, EpicAttemptRow>();

  constructor(private readonly deps: EpicVerificationRunnerDeps) {}

  getTrackedAttempt(epicRef: number): EpicAttemptRow | undefined {
    return this.runningAttempts.get(epicRef);
  }

  clearTrackedAttempt(epicRef: number): void {
    this.runningAttempts.delete(epicRef);
  }

  worktreePath(epicRef: number): string | undefined {
    return this.deps.worktrees.get(epicRef);
  }

  async resolveWorkspaceVerifiers() {
    const live = (await this.deps.getWorkspaces()).find((candidate) => candidate.id === this.deps.workspace.id) ?? this.deps.workspace;
    return resolveVerifiers(live, this.deps.getConfig());
  }

  async verify({ repoDir, epicRef, verifiedHeadOid }: { repoDir: string; epicRef: number; verifiedHeadOid: string }): Promise<VerificationDecision> {
    const { epicAttempts } = this.deps;
    const attempt = epicAttempts ? await epicAttempts.createForEpic({ workspaceId: this.deps.workspace.id, epicRef }) : undefined;
    const criticUsages: Parameters<typeof withCriticContribution>[2] = [];
    if (attempt) {
      this.runningAttempts.set(epicRef, attempt);
      this.publishEpicAttempt(attempt);
    }
    try {
      const worktreePath = await this.deps.worktrees.acquire(repoDir, epicRef);
      const decision = await verifyEpicIntegration({
        worktreePath,
        verifiedHeadOid,
        verifiers: (await this.resolveWorkspaceVerifiers()).epic.preMerge,
        onCommand: (commandAttempt, command) => this.recordCommandStep(attempt, commandAttempt, command),
        runCritic: (args) => this.runEpicCritic({ repoDir, epicRef, attempt, criticUsages, ...args }),
      });
      if (attempt && criticUsages.length > 0) {
        const contribution = withCriticContribution(null, null, criticUsages);
        this.publishEpicAttempt(await epicAttempts!.updateWithFrozenCost(attempt.id, {
          usage: contribution.usage ? JSON.stringify(contribution.usage) : null,
          cost: contribution.cost ? JSON.stringify(contribution.cost) : null,
        }));
      }
      if (attempt && decision.outcome === 'proceed') {
        this.publishEpicAttempt(await epicAttempts!.updateWithFrozenCost(attempt.id, { state: 'passed', reason: 'epic-verification', endedAt: Date.now(), verifiedHeadOid }));
        this.runningAttempts.delete(epicRef);
      }
      return decision;
    } catch (error) {
      if (attempt) {
        this.publishEpicAttempt(await epicAttempts!.updateWithFrozenCost(attempt.id, {
          state: 'failed',
          reason: 'epic-verification',
          detail: error instanceof Error ? error.message : String(error),
          endedAt: Date.now(),
          verifiedHeadOid,
        }));
        this.runningAttempts.delete(epicRef);
      }
      throw error;
    }
  }

  private publishEpicAttempt(attempt: AttemptRow): void {
    if (isEpicAttempt(attempt)) this.deps.onEpicAttemptChanged?.(attempt);
  }

  private async recordCommandStep(attempt: EpicAttemptRow | undefined, commandAttempt: CommandAttempt, command: EpicVerificationStage['commands'][number]): Promise<void> {
    const { epicAttempts, verificationAttemptStore } = this.deps;
    if (!attempt || !verificationAttemptStore || !epicAttempts) return;
    const persisted = await verificationAttemptStore.append(attempt.id, commandAttemptToInput(commandAttempt));
    const step = await epicAttempts.createStep(attempt.id, {
      type: 'verification',
      command: [command.command, ...command.args].join(' '),
      logLocator: `verification_attempt:${persisted.id}`,
    });
    await epicAttempts.updateStep(step.id, {
      state: commandAttempt.verdict === 'pass' ? 'passed' : 'failed',
      verdict: commandAttempt.verdict,
      startedAt: persisted.ts,
      endedAt: Date.now(),
    });
  }

  private async runEpicCritic({ repoDir, epicRef, attempt, criticUsages, cwd, verifiedHeadOid: criticHeadOid, critic }: {
    repoDir: string;
    epicRef: number;
    attempt: EpicAttemptRow | undefined;
    criticUsages: Parameters<typeof withCriticContribution>[2];
    cwd: string;
    verifiedHeadOid: string;
    critic: EpicVerificationStage['critics'][number];
  }): Promise<VerifierVerdict & { summary?: string; output?: string }> {
    const { epicAttempts, verificationAttemptStore, criticDrive, getConfig } = this.deps;
    const config = getConfig();
    const harnessId = critic.harness ?? config.defaults.harness;
    const harness = config.harnesses[harnessId];
    if (!harness) {
      return {
        verifier: 'critic',
        verdict: 'inconclusive',
        summary: `critic harness '${harnessId}' is not configured`,
        output: '',
      };
    }
    const defaultBranch = await resolveRepositoryDefaultBranch(repoDir);
    const baseOid = defaultBranch === null
      ? null
      : await Git.mergeBase(repoDir, defaultBranch, integrationBranchName(epicRef)).catch(() => null);
    const criticAttempt = await runCritic({
      cwd,
      verifiedHeadOid: criticHeadOid,
      ...(baseOid ? { baseOid } : {}),
      critic: { prompt: critic.prompt, model: critic.model, ...(critic.harness ? { harness: critic.harness } : {}) },
      fields: { taskId: '', skill: '/implement', ref: String(epicRef), url: '', title: `Epic #${epicRef}`, description: '' },
      harness,
      harnessId,
      ...(criticDrive ? { drive: criticDrive } : {}),
    });
    const usage = collectUsage({
      harnessId,
      harness,
      cwd,
      sessionId: criticAttempt.sessionId,
      ...(criticAttempt.usage ? { promptResult: { usage: criticAttempt.usage } } : {}),
      prices: pricesForHarness(harness),
    });
    if (usage) criticUsages.push({ usage, prices: pricesForHarness(harness) });
    if (attempt && verificationAttemptStore && epicAttempts) {
      const persisted = await verificationAttemptStore.append(attempt.id, {
        ...criticAttemptToInput(criticAttempt),
        ...(usage ? { usage: JSON.stringify(usage) } : {}),
      });
      const step = await epicAttempts.createStep(attempt.id, {
        type: 'review',
        logLocator: `verification_attempt:${persisted.id}`,
      });
      await epicAttempts.updateStep(step.id, {
        state: criticAttempt.verdict === 'pass' ? 'passed' : 'failed',
        verdict: criticAttempt.verdict,
        startedAt: persisted.ts,
        endedAt: Date.now(),
      });
    }
    return {
      verifier: criticAttempt.verifier,
      verdict: criticAttempt.verdict,
      summary: criticAttempt.summary,
      output: criticAttempt.output,
    };
  }
}
