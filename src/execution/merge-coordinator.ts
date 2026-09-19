import { Git } from './git.js';
import { reportFailure } from '../error-handling.js';
import { driveFields } from './prompt-template.js';
import { indexWorktree } from './code-index.js';
import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import { DomainError } from '../domain/errors.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import type { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import type { TranscriptCapture } from './transcript-capture.js';
import { runCommandVerifier, commandAttemptToInput } from '../verification/command-verifier.js';
import { createAcpCriticDrive, runCritic, criticAttemptToInput } from '../verification/critic.js';
import { combineVerdicts } from '../verification/combine.js';
import { integrationBranchName } from './epic-coordinator.js';
import { logger } from '../logger.js';
import { startOperation } from '../telemetry/operations.js';
import { runMergePolicy, type MergePolicyDeps, type MergePolicyOutcome, type MergeStepEvent, type PostMergeCheckResult } from './merge-policy.js';
import type { RunnerOptions } from './runner.js';

export const RESOLVE_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Thrown by {@link MergeCoordinator.resolveBaseBranch} when a worktree Attempt's base branch
 * cannot be resolved to a real branch name: the base repo is on a detached HEAD
 * and the Task carries no explicit `baseBranch`. `reason` tells the operator how
 * to fix it: reattach the base repo to a branch, or set the Task's base.
 */
export class BaseBranchUnresolved extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'BaseBranchUnresolved';
  }
}

/**
 * Thrown by {@link MergeCoordinator.resolveBaseBranch} and inside `Runner.prepareWorkspace`
 * when a worktree Attempt's resolved base is an Epic integration branch (`epic/<ref>`) that
 * does NOT currently exist. A transient condition: the Runner settles the Run back to `ready`
 * to be re-picked rather than escalating.
 */
export class EpicBaseNotReady extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'EpicBaseNotReady';
  }
}

export interface EpicIntegrationMergeInput {
  workspaceId: number;
  repoDir: string;
  epicRef: number;
  defaultBranch: string;
  integrationBranch: string;
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
}

export interface MergeCoordinatorDeps {
  getConfig: () => AppConfig;
  attempts: AttemptStore;
  verificationAttempts: VerificationAttemptStore;
  epicMergeEvents: EpicMergeEventStore;
  transcripts: TranscriptCapture;
  getWorkspace: RunnerOptions['getWorkspace'];
  criticDrive: RunnerOptions['criticDrive'];
  postMerge: RunnerOptions['postMerge'];
  urlFor: (task: TaskRow) => string | null;
  listWorkingTasks: () => Promise<TaskRow[]>;
  latestAttemptFor: (task: Pick<TaskRow, 'id'>) => Promise<AttemptRow>;
  updateStep: (taskId: number, id: number, patch: Parameters<AttemptStore['updateStep']>[1]) => Promise<Awaited<ReturnType<AttemptStore['updateStep']>>>;
  criticUpdateRelay: (attemptId: number) => (update: { sessionUpdate: string; [key: string]: unknown }) => void;
  recordRunEvent: (task: TaskRow, run: AttemptRow, type: 'lifecycle', payload: unknown) => void;
  settleEscalated: (task: TaskRow, run: AttemptRow, reason: string, patch: Partial<AttemptRow>) => Promise<void>;
  onEpicMergeStep: (payload: { workspaceId: number; epicRef: number }) => void;
}

export class MergeCoordinator {
  constructor(private readonly deps: MergeCoordinatorDeps) {}

  /**
   * The candidate commit an operator Accept would merge: a worktree Attempt's
   * branch tip once it has commits ahead of its base, or a direct Attempt's
   * captured `verifiedHeadOid`. Null means there is nothing to accept.
   */
  async candidateHead(task: TaskRow, run: AttemptRow): Promise<string | null> {
    if (task.isolationMode === 'worktree') {
      if (run.branch && run.baseBranch && (await Git.commitsAhead(task.workingDir, run.baseBranch, run.branch)) > 0) {
        return await Git.revParse(task.workingDir, run.branch);
      }
      return null;
    }
    return run.verifiedHeadOid ?? null;
  }

  async resolveBaseBranch(task: TaskRow): Promise<string> {
    if (task.mapRef !== null) {
      const branch = integrationBranchName(task.mapRef);
      if (task.baseBranch === branch) return branch;
      if (await Git.branchExists(task.workingDir, branch)) {
        throw new EpicBaseNotReady(
          `task ${task.id} is an Epic member (${branch}) whose base is not yet its integration branch ` +
            `(currently ${task.baseBranch ?? 'unassigned'}); it is retargeted on the next tracker poll — retry shortly`,
        );
      }
    }
    if (task.baseBranch) return task.baseBranch;
    const branch = await Git.symbolicBranch(task.workingDir);
    if (branch) return branch;
    await Git.assertRepo(task.workingDir);
    throw new BaseBranchUnresolved(
      `base repo ${task.workingDir} is on a detached HEAD with no current branch, and the Task has no explicit base branch; ` +
        'reattach the base repo to a branch (e.g. `git checkout <branch>`) or set an explicit base branch on the Task, then retry',
    );
  }

  async runRebaseTask(
    task: TaskRow,
    attemptNumber: number,
    attemptStartedAt: number,
    worktreePath: string,
    baseBranch: string,
  ): Promise<{ ok: true; tip: string } | { ok: false; conflict: boolean; detail: string }> {
    const attempt = await this.deps.attempts.ensureForRun(task.id, attemptNumber, attemptStartedAt);
    const row = await this.deps.attempts.createStep(attempt.id, { type: 'rebase', logLocator: `git:rebase:${baseBranch}` });
    await this.deps.updateStep(task.id, row.id, { state: 'running', startedAt: Date.now() });
    const baseOid = await Git.revParse(task.workingDir, baseBranch);
    const rebased = await Git.rebaseOnto(worktreePath, baseOid);
    if (!rebased.ok) {
      await this.deps.updateStep(task.id, row.id, {
        state: 'failed',
        verdict: rebased.conflict ? 'fail' : 'inconclusive',
        endedAt: Date.now(),
        logLocator: `git:rebase:${baseBranch}@${baseOid}\n${rebased.detail}`,
      });
      return { ok: false, conflict: rebased.conflict, detail: rebased.detail };
    }
    await this.deps.updateStep(task.id, row.id, {
      state: 'passed',
      verdict: 'pass',
      endedAt: Date.now(),
      logLocator: `git:rebase:${baseBranch}@${baseOid}`,
    });
    return { ok: true, tip: rebased.rebasedTip };
  }

  /**
   * Operator Accept runs the identical one merge policy the automated path
   * does. The escalated Attempt is already terminal, so escalation is returned to
   * the caller rather than settled here.
   */
  async mergeAcceptedBranch(task: TaskRow, run: AttemptRow): Promise<MergePolicyOutcome> {
    const record = (type: 'lifecycle', payload: unknown) => this.deps.recordRunEvent(task, run, type, payload);
    const deps: MergePolicyDeps = {
      ...this.mergePolicyDeps(task, run, record, new AbortController().signal, {}),
      escalate: async () => {},
    };
    const operation = startOperation({ type: 'attempt', attributes: { 'task.id': task.id, 'attempt.id': run.id } });
    const outcome = await operation
      .run(async () =>
        runMergePolicy(
          {
            baseDir: task.workingDir,
            baseBranch: run.baseBranch!,
            taskBranch: run.branch!,
            conflictResolveTurns: task.conflictResolveTurns,
            postMergeCheck: this.deps.getConfig().merge.postMergeCheck,
            spanAttributes: { 'task.id': task.id, 'attempt.id': run.id },
          },
          deps,
        ),
      )
      .finally(() => operation.end());
    if (outcome.kind === 'merged') {
      record('lifecycle', { event: 'merged', oid: outcome.mergeOid, baseBranch: run.baseBranch });
      await this.deps.postMerge?.({ repoDir: task.workingDir, baseBranch: run.baseBranch! });
    } else {
      record('lifecycle', { event: 'escalated', reason: outcome.message, gate: outcome.reason });
    }
    return outcome;
  }

  /**
   * Integrate an Epic's `epic/<ref>` branch into the default branch under the
   * one merge policy. The harness/model is resolved from a live member (else
   * the Workspace default). Escalation is returned to the caller, which owns
   * the Epic-level escalation surface, rather than settled here.
   */
  async mergeEpicIntegration(input: EpicIntegrationMergeInput): Promise<MergePolicyOutcome> {
    const config = this.deps.getConfig();
    const host = (await this.deps.listWorkingTasks()).find((task) => task.baseBranch === input.integrationBranch);
    const harnessId = host?.harness ?? config.defaults.harness;
    const harness = config.harnesses[harnessId as keyof AppConfig['harnesses']];
    const model = host?.model ?? harness?.defaultModel ?? '';
    const deps: MergePolicyDeps = {
      resolveConflictTurn: async (ctx) => {
        try {
          if (!harness) return;
          const drive = this.deps.criticDrive ?? createAcpCriticDrive();
          const prompt =
            `## Epic integration merge conflict resolution (turn ${ctx.turn})\n` +
            `Merging the Epic integration branch \`${ctx.taskBranch}\` into \`${ctx.baseBranch}\` conflicted in:\n` +
            ctx.unmergedPaths.map((path) => `- ${path}`).join('\n') +
            `\n\nThis checkout (\`${ctx.baseDir}\`) has \`${ctx.baseBranch}\` checked out with that merge in progress — conflict ` +
            `markers are present in the listed paths. Resolve the conflicts so the result keeps both \`${ctx.baseBranch}\`'s and ` +
            `\`${ctx.taskBranch}\`'s work, then \`git add\` the resolved paths. Do not run \`git commit\`, do not create or switch ` +
            `branches, do not push, and do not change anything beyond what resolving this merge requires.`;
          await drive.run({
            harness,
            harnessId,
            model,
            cwd: ctx.baseDir,
            prompt,
            timeoutMs: RESOLVE_TURN_TIMEOUT_MS,
          });
        } catch (err) {
          reportFailure(err, {
            op: 'runner.mergeEpicIntegration.resolveConflictTurn',
            level: 'warn',
            context: {
              workspaceId: input.workspaceId,
              epicRef: input.epicRef,
              turn: ctx.turn,
              baseBranch: ctx.baseBranch,
              taskBranch: ctx.taskBranch,
              unmergedPaths: ctx.unmergedPaths.length,
              harnessId,
              model,
            },
          });
        }
      },
      runPostMergeCheck: input.runPostMergeCheck,
      escalate: async () => {},
      onStep: (step) => persistStep(step),
    };
    let persistChain: Promise<unknown> = Promise.resolve();
    const persistStep = (step: MergeStepEvent): void => {
      persistChain = persistChain
        .then(async () => {
          if (step.step === 'started') await this.deps.epicMergeEvents.clear(input.workspaceId, input.epicRef);
          await this.deps.epicMergeEvents.append(input.workspaceId, input.epicRef, step);
          this.deps.onEpicMergeStep({ workspaceId: input.workspaceId, epicRef: input.epicRef });
        })
        .catch((err) => logger.warn('epic merge step persist failed', { error: err instanceof Error ? err.message : String(err) }));
    };
    const outcome = await runMergePolicy(
      {
        baseDir: input.repoDir,
        baseBranch: input.defaultBranch,
        taskBranch: input.integrationBranch,
        conflictResolveTurns: host?.conflictResolveTurns ?? config.defaults.conflictResolveTurns,
        postMergeCheck: config.merge.postMergeCheck,
      },
      deps,
    );
    await persistChain;
    if (outcome.kind === 'merged') {
      await this.deps.postMerge?.({ repoDir: input.repoDir, baseBranch: input.defaultBranch });
    }
    return outcome;
  }

  mergePolicyDeps(
    task: TaskRow,
    run: AttemptRow,
    record: (type: 'lifecycle', payload: unknown) => void,
    signal: AbortSignal,
    patch: Partial<AttemptRow>,
  ): MergePolicyDeps {
    return {
      onStep: (event) => record('lifecycle', { event: 'merge-step', step: event }),
      resolveConflictTurn: async (ctx) => {
        try {
          const config = this.deps.getConfig();
          const harnessId = task.harness;
          const harness = config.harnesses[harnessId as keyof typeof config.harnesses];
          if (!harness) return;
          const drive = this.deps.criticDrive ?? createAcpCriticDrive();
          const prompt =
            `## Merge conflict resolution (turn ${ctx.turn})\n` +
            `Merging \`${ctx.taskBranch}\` into \`${ctx.baseBranch}\` conflicted in:\n` +
            ctx.unmergedPaths.map((path) => `- ${path}`).join('\n') +
            `\n\nThis checkout (\`${ctx.baseDir}\`) has \`${ctx.baseBranch}\` checked out with that merge in progress — conflict ` +
            `markers are present in the listed paths. Resolve the conflicts so the result keeps both \`${ctx.baseBranch}\`'s and ` +
            `\`${ctx.taskBranch}\`'s work, then \`git add\` the resolved paths. Do not run \`git commit\`, do not create or switch ` +
            `branches, do not push, and do not change anything beyond what resolving this merge requires.`;
          await drive.run({
            harness,
            harnessId,
            model: task.model,
            cwd: ctx.baseDir,
            prompt,
            timeoutMs: RESOLVE_TURN_TIMEOUT_MS,
          });
        } catch (err) {
          reportFailure(err, {
            op: 'runner.mergeDeps.resolveConflictTurn',
            level: 'warn',
            context: {
              taskId: task.id,
              attemptId: run.id,
              turn: ctx.turn,
              baseBranch: ctx.baseBranch,
              taskBranch: ctx.taskBranch,
              unmergedPaths: ctx.unmergedPaths.length,
              harness: task.harness,
              model: task.model,
            },
          });
        }
      },
      runPostMergeCheck: async (mergeOid, baseDir) => {
        const config = this.deps.getConfig();
        const ws = await this.deps.getWorkspace?.(task.workspaceId);
        const { task: resolvedTask } = resolveVerifiers(
          ws ?? { taskPreMergeCommands: null, taskPreMergeCritics: null, taskPostMergeCommands: null, taskPostMergeCritics: null, epicPreMergeCommands: null, epicPreMergeCritics: null },
          config,
        );
        const { commands, critics } = resolvedTask.postMerge;
        const timelineAttempt = await this.deps.latestAttemptFor(task);
        for (const command of commands) {
          const attempt = await runCommandVerifier({
            cwd: baseDir,
            verifiedHeadOid: mergeOid,
            command,
            signal,
            attributes: { 'task.id': task.id, 'attempt.id': run.id },
          });
          await this.deps.verificationAttempts.append(timelineAttempt.id, commandAttemptToInput(attempt));
          record('lifecycle', { event: 'verification', mechanism: 'command', verdict: attempt.verdict, summary: attempt.summary });
          if (attempt.verdict !== 'pass') return { pass: false, output: attempt.output };
        }
        const baseOid = await Git.revParse(baseDir, `${mergeOid}^1`).catch(() => null);
        if (critics.length > 0) await indexWorktree(baseDir);
        const criticAttempts = await Promise.all(critics.map(async (configuredCritic) => {
          const critic = {
            prompt: task.trackerRef == null ? configuredCritic.noIssuePrompt : configuredCritic.issuePrompt,
            model: configuredCritic.model,
            ...(configuredCritic.harness ? { harness: configuredCritic.harness } : {}),
          };
          const criticHarnessId = critic.harness ?? task.harness;
          const criticHarness = config.harnesses[criticHarnessId as keyof typeof config.harnesses];
          if (!criticHarness) {
            throw new DomainError('validation', `critic harness '${criticHarnessId}' is not configured`);
          }
          const attempt = await runCritic({
            cwd: baseDir,
            verifiedHeadOid: mergeOid,
            ...(baseOid ? { baseOid } : {}),
            critic,
            timeoutMs: configuredCritic.timeoutSeconds * 1000,
            fields: driveFields(task, this.deps.urlFor),
            harness: criticHarness,
            harnessId: criticHarnessId,
            attributes: { 'task.id': task.id, 'attempt.id': run.id },
            ...(this.deps.criticDrive ? { drive: this.deps.criticDrive } : {}),
            onUpdate: this.deps.criticUpdateRelay(run.id),
          });
          const persisted = await this.deps.verificationAttempts.append(timelineAttempt.id, criticAttemptToInput(attempt));
          if (attempt.sessionId) {
            if (attempt.transcriptPath === null) {
              void this.deps.transcripts.captureCriticTranscript({
                attemptId: persisted.id,
                sessionId: attempt.sessionId,
                harnessId: criticHarnessId,
                sessionLogDir: criticHarness.sessionLogDir,
              });
            }
            void this.deps.transcripts.captureCriticUsage({
              attemptId: persisted.id,
              sessionId: attempt.sessionId,
              harnessId: criticHarnessId,
              cwd: baseDir,
            });
          }
          record('lifecycle', { event: 'verification', mechanism: 'critic', verdict: attempt.verdict, summary: attempt.summary });
          return attempt;
        }));
        const decision = combineVerdicts(criticAttempts.map((attempt) => ({ verifier: attempt.verifier, verdict: attempt.verdict })));
        if (decision.outcome === 'proceed') return { pass: true, output: '' };
        return {
          pass: false,
          output: criticAttempts
            .map((attempt, index) => [attempt, index] as const)
            .filter(([attempt]) => attempt.verdict !== 'pass')
            .map(([attempt, index]) => [
              `Task critic ${index + 1} (${attempt.verdict}): ${attempt.summary}`,
              attempt.output,
            ].filter(Boolean).join('\n'))
            .join('\n\n'),
        };
      },
      escalate: async (reason) => {
        await this.deps.settleEscalated(task, run, reason, patch);
      },
    };
  }
}
