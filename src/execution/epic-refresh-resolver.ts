import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from './git.js';
import { bestEffort, reportFailure } from '../error-handling.js';
import { integrationBranchName, type EpicRefreshResolveDispatchOutcome, type EpicRefreshTarget } from './epic-coordinator.js';
import { RESOLVE_TURN_TIMEOUT_MS } from './merge-coordinator.js';
import { createAcpCriticDrive } from '../verification/critic.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskService } from '../domain/tasks.js';
import type { RunnerOptions } from './runner.js';

export interface EpicRefreshResolverDeps {
  taskService: TaskService;
  getConfig: () => AppConfig;
  worktreesDir: string;
  criticDrive: RunnerOptions['criticDrive'];
}

export class EpicRefreshResolver {
  constructor(private readonly deps: EpicRefreshResolverDeps) {}

  /**
   * Dispatch the bounded corrective turn for an integration refresh: check
   * `epic/<ref>` out into a dedicated worktree, reproduce the conflicted merge
   * of the default branch there, and drive one agent turn against that
   * worktree to resolve and commit it. A live member supplies the harness/model
   * when one is running, else the Workspace default harness. Every pre-turn
   * failure returns `escalated` synchronously; the agent turn itself is
   * fire-and-forget (it must NOT hold the caller's repo lock), after which
   * `retry` re-runs the refresh.
   *
   * Known limitation (#382): while the turn holds `epic/<ref>` checked out, a
   * member of the same Epic merging concurrently fails git's second checkout of
   * `epic/<ref>` and is re-attempted later.
   */
  async enqueueEpicRefreshResolution(
    target: EpicRefreshTarget,
    detail: string,
    escalate: (epicRef: number, reason: string) => void | Promise<void>,
    retry: () => Promise<unknown>,
  ): Promise<EpicRefreshResolveDispatchOutcome> {
    const branch = integrationBranchName(target.ref);
    const escalated = async (reason: string): Promise<EpicRefreshResolveDispatchOutcome> => {
      await escalate(target.ref, reason);
      return { status: 'escalated', reason };
    };
    const config = this.deps.getConfig();
    const host = (await this.deps.taskService.list({ state: 'working' })).find((task) => task.baseBranch === branch);
    const harnessId = host?.harness ?? config.defaults.harness;
    const harness = config.harnesses[harnessId as keyof AppConfig['harnesses']];
    if (!harness) {
      return escalated(`harness '${harnessId}' is not configured to run the refresh corrective turn for ${branch}: ${detail}`);
    }
    const model = host?.model ?? harness.defaultModel;

    mkdirSync(this.deps.worktreesDir, { recursive: true });
    const worktreePath = join(this.deps.worktreesDir, `epic-refresh-${target.ref}`);
    try {
      await Git.addWorktreeCheckout(target.repoDir, worktreePath, branch);
    } catch (err) {
      return escalated(`could not check out ${branch} for the refresh corrective turn (${String(err)}); refresh conflict: ${detail}`);
    }
    let reproduced: { ok: boolean; detail?: string };
    try {
      reproduced = await Git.mergeLeavingConflict(worktreePath, target.defaultBranch);
    } catch (err) {
      await bestEffort(() => Git.removeWorktree(target.repoDir, worktreePath), {
        op: 'runner.enqueueEpicRefreshResolution.removeWorktree',
        level: 'debug',
        context: { epicRef: target.ref, repoDir: target.repoDir, worktreePath },
      });
      return escalated(`could not reproduce the refresh conflict on ${branch} (${String(err)}); refresh conflict: ${detail}`);
    }

    const turn = () =>
      this.runEpicRefreshResolveTurn({
        target,
        branch,
        worktreePath,
        conflicted: !reproduced.ok,
        conflictDetail: reproduced.detail ?? detail,
        harness,
        harnessId,
        model,
      });
    void turn()
      .then(() => retry())
      .catch(async (err) => {
        await escalate(target.ref, `refresh re-attempt after the corrective turn failed for ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return { status: 'dispatched' };
  }

  private async runEpicRefreshResolveTurn(args: {
    target: EpicRefreshTarget;
    branch: string;
    worktreePath: string;
    conflicted: boolean;
    conflictDetail: string;
    harness: HarnessConfig;
    harnessId: string;
    model: string;
  }): Promise<void> {
    try {
      if (args.conflicted) {
        const drive = this.deps.criticDrive ?? createAcpCriticDrive();
        const prompt =
          `## Epic integration refresh — merge conflict resolution\n` +
          `Merging \`${args.target.defaultBranch}\` into the Epic integration branch \`${args.branch}\` conflicted:\n${args.conflictDetail}\n\n` +
          `This worktree has \`${args.branch}\` checked out with that merge in progress — conflict markers are present. ` +
          `Resolve the conflicts so the result keeps both \`${args.branch}\`'s work and \`${args.target.defaultBranch}\`'s changes, ` +
          `then complete the merge (\`git add -A\` and \`git commit --no-edit\`). ` +
          `Do not create or switch branches, do not push, and do not change anything beyond what resolving this merge requires.`;
        await drive.run({
          harness: args.harness,
          harnessId: args.harnessId,
          model: args.model,
          cwd: args.worktreePath,
          prompt,
          timeoutMs: RESOLVE_TURN_TIMEOUT_MS,
        });
      }
    } catch (err) {
      reportFailure(err, {
        op: 'runner.epicRefreshResolveTurn',
        level: 'warn',
        context: {
          branch: args.branch,
          worktreePath: args.worktreePath,
          repoDir: args.target.repoDir,
          harnessId: args.harnessId,
          model: args.model,
          conflicted: args.conflicted,
        },
      });
    } finally {
      await bestEffort(() => Git.removeWorktree(args.target.repoDir, args.worktreePath), {
        op: 'runner.runEpicRefreshResolveTurn.removeWorktree',
        level: 'debug',
        context: { epicRef: args.target.ref, repoDir: args.target.repoDir, worktreePath: args.worktreePath },
      });
    }
  }
}
