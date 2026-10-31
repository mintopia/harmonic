import type { TrackerRef } from '../tracker/adapter.js';
import type { RoutingService } from '../domain/routing.js';
import { Git } from './git.js';
import { reportFailure } from '../error-handling.js';
import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { EpicMergeEventStore, EpicTimelineStep } from '../domain/epic-merge-events.js';
import { runTimedCriticDrive } from '../verification/critic.js';
import { integrationBranchName } from './epic-coordinator.js';
import { logger } from '../logger.js';
import { runMergePolicy, type MergePolicyDeps, type MergePolicyOutcome, type PostMergeCheckResult } from './merge-policy.js';
import type { RunnerOptions } from './runner.js';
import type { RunnerEvents } from './runner-options.js';
import type { TaskArchive } from '../archive/task-archive.js';
import { resolveMergePrompts } from '../domain/setting-override.js';
import { renderConflictPrompt } from './prompt-assembly.js';

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
  epicRef: TrackerRef;
  defaultBranch: string;
  integrationBranch: string;
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
}

export interface MergeCoordinatorDeps {
  getConfig: () => AppConfig;
  attempts: AttemptStore;
  epicMergeEvents: EpicMergeEventStore;
  criticDrive: RunnerOptions['criticDrive'];
  archive?: TaskArchive | undefined;
  onAttemptEvent?: RunnerEvents['onAttemptEvent'];
  getWorkspace?: RunnerOptions['getWorkspace'];
  postMerge: RunnerOptions['postMerge'];
  listWorkingTasks: () => Promise<TaskRow[]>;
  routing: Pick<RoutingService, 'epicRoute'>;
  onEpicMergeStep: (payload: { workspaceId: number; epicRef: TrackerRef }) => void;
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

  /**
   * Integrate an Epic's `epic/<ref>` branch into the default branch under the
   * one merge policy. The conflict turn's harness/model is the Epic's own
   * Routing Label, else the Workspace/global default. Escalation is returned to the caller, which owns
   * the Epic-level escalation surface, rather than settled here.
   */
  async mergeEpicIntegration(input: EpicIntegrationMergeInput): Promise<MergePolicyOutcome> {
    const config = this.deps.getConfig();
    const epicAttempt = (await this.deps.attempts.listForEpic({ workspaceId: input.workspaceId, epicRef: input.epicRef })).at(-1);
    const host = (await this.deps.listWorkingTasks()).find((task) => task.baseBranch === input.integrationBranch);
    const route = await this.deps.routing.epicRoute(input.workspaceId, input.epicRef);
    const deps: MergePolicyDeps = {
      resolveConflictTurn: async (ctx) => {
        try {
          if (!route.ok) {
            logger.warn('epic conflict turn skipped: harness not configured', { epicRef: input.epicRef, harness: route.harness, routingLabel: route.label ?? '' });
            return;
          }
          const { harness: harnessId, model, config: harness } = route;
          const drive = this.deps.criticDrive;
          const merge = resolveMergePrompts(await this.deps.getWorkspace?.(input.workspaceId), config);
          const prompt = renderConflictPrompt(merge.epicConflictPrompt, merge.fragments, ctx);
          const archived = await this.deps.archive?.appendResolutionPrompt({ workspaceId: input.workspaceId, epicRef: input.epicRef }, epicAttempt?.number ?? 1, 'epic-conflict', ctx.turn, prompt);
          if (epicAttempt) await this.recordEpicEvent(epicAttempt.id, { event: 'merge-conflict-resolve', turn: ctx.turn, ...archived });
          else if (archived) persistStep({ step: 'resolver-prompt', kind: 'merge-conflict', turn: ctx.turn, attempt: 1, ...archived });
          const request = {
            harness,
            harnessId,
            model,
            cwd: ctx.baseDir,
            prompt,
            timeoutMs: RESOLVE_TURN_TIMEOUT_MS,
          };
          if (epicAttempt) {
            await runTimedCriticDrive(drive, request, (ms) => this.deps.attempts.addAgentDuration(epicAttempt.id, ms));
          } else {
            await drive.run(request);
          }
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
              harnessId: route.harness,
              ...(route.ok ? { model: route.model } : {}),
            },
          });
        }
      },
      runPostMergeCheck: input.runPostMergeCheck,
      escalate: async () => {},
      onStep: (step) => persistStep(step),
    };
    let persistChain: Promise<unknown> = Promise.resolve();
    const persistStep = (step: EpicTimelineStep): void => {
      persistChain = persistChain
        .then(async () => {
          await this.deps.epicMergeEvents.append(input.workspaceId, input.epicRef, step);
          this.deps.onEpicMergeStep({ workspaceId: input.workspaceId, epicRef: input.epicRef });
        })
        .catch((err) => logger.warn('epic merge step persist failed', { error: err instanceof Error ? err.message : String(err) }));
    };
    const conflictResolveTurns = host?.conflictResolveTurns ?? config.defaults.conflictResolveTurns;
    const outcome = await runMergePolicy(
      {
        baseDir: input.repoDir,
        baseBranch: input.defaultBranch,
        taskBranch: input.integrationBranch,
        conflictResolveTurns,
        postMergeCheck: config.merge.postMergeCheck,
      },
      deps,
    );
    await persistChain;
    if (outcome.kind === 'merged') {
      await this.deps.postMerge?.({ repoDir: input.repoDir, baseBranch: input.defaultBranch });
    }
    if (outcome.kind === 'escalated' && outcome.reason === 'conflict' && conflictResolveTurns > 0 && !route.ok) {
      return { ...outcome, message: `${route.reason} It cannot run the conflict resolution turn. ${outcome.message}` };
    }
    return outcome;
  }

  private async recordEpicEvent(attemptId: number, payload: Record<string, unknown>): Promise<void> {
    try {
      this.deps.onAttemptEvent?.(await this.deps.attempts.appendEvent(attemptId, { type: 'lifecycle', payload }));
    } catch (err) {
      logger.warn('epic attempt event failed', { attemptId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
