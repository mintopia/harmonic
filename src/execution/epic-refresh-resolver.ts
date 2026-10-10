import type { TrackerRef } from '../tracker/adapter.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from './git.js';
import { bestEffort, reportFailure, type FireAndForget } from '../error-handling.js';
import { integrationBranchName, type EpicRefreshResolveDispatchOutcome, type EpicRefreshResolveTarget } from './epic-coordinator.js';
import { RESOLVE_TURN_TIMEOUT_MS } from './merge-coordinator.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { RoutingService } from '../domain/routing.js';
import type { RunnerOptions } from './runner.js';
import type { RunnerEvents } from './runner-options.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import type { TaskArchive } from '../archive/task-archive.js';
import { renderEpicRefreshPrompt } from './prompt-assembly.js';
import { resolveEpicResolverPrompts } from '../domain/setting-override.js';
import { logger } from '../logger.js';

export interface EpicRefreshResolverDeps {
  routing: Pick<RoutingService, 'epicRoute'>;
  attempts: AttemptStore;
  archive?: TaskArchive | undefined;
  epicMergeEvents: Pick<EpicMergeEventStore, 'append'>;
  onAttemptEvent?: RunnerEvents['onAttemptEvent'];
  getConfig: () => AppConfig;
  getWorkspace: RunnerOptions['getWorkspace'];
  worktreesDir: string;
  criticDrive: RunnerOptions['criticDrive'];
  fireAndForget: FireAndForget;
}

export class EpicRefreshResolver {
  private readonly liveWorktrees = new Set<string>();

  constructor(private readonly deps: EpicRefreshResolverDeps) {}

  /**
   * Dispatch the bounded corrective turn for an integration refresh: check
   * `epic/<ref>` out into a dedicated worktree, reproduce the conflicted merge
   * of the default branch there, and drive one agent turn against that
   * worktree to resolve and commit it. The Epic's own Routing Label supplies the
   * harness/model, else the Workspace/global default. Every pre-turn
   * failure returns `escalated` synchronously; the agent turn itself is
   * fire-and-forget (it must NOT hold the caller's repo lock), after which
   * `retry` re-runs the refresh.
   *
   * Known limitation (#382): while the turn holds `epic/<ref>` checked out, a
   * member of the same Epic merging concurrently fails git's second checkout of
   * `epic/<ref>` and is re-attempted later.
   */
  async enqueueEpicRefreshResolution(
    target: EpicRefreshResolveTarget,
    detail: string,
    escalate: (epicRef: TrackerRef, reason: string) => void | Promise<void>,
    retry: () => Promise<unknown>,
  ): Promise<EpicRefreshResolveDispatchOutcome> {
    const branch = integrationBranchName(target.ref);
    const escalated = async (reason: string): Promise<EpicRefreshResolveDispatchOutcome> => {
      await escalate(target.ref, reason);
      return { status: 'escalated', reason };
    };
    const route = await this.deps.routing.epicRoute(target.workspaceId, target.ref);
    if (!route.ok) return escalated(`${route.reason} It cannot run the refresh corrective turn for ${branch}: ${detail}`);
    const { harness: harnessId, model, config: harness } = route;

    mkdirSync(this.deps.worktreesDir, { recursive: true });
    const worktreePath = join(this.deps.worktreesDir, `epic-refresh-${target.ref}`);
    try {
      if (!this.liveWorktrees.has(worktreePath)) {
        if (existsSync(worktreePath)) await Git.removeWorktree(target.repoDir, worktreePath).catch(() => undefined);
        await Git.pruneWorktrees(target.repoDir);
      }
      await Git.addWorktreeCheckout(target.repoDir, worktreePath, branch);
    } catch (err) {
      return escalated(`could not check out ${branch} for the refresh corrective turn (${String(err)}); refresh conflict: ${detail}`);
    }
    let reproduced: { ok: boolean; detail?: string };
    try {
      reproduced = await Git.mergeLeavingConflict(worktreePath, target.defaultBranch);
    } catch (err) {
      this.liveWorktrees.delete(worktreePath);
      await bestEffort(() => Git.removeWorktree(target.repoDir, worktreePath), {
        op: 'runner.enqueueEpicRefreshResolution.removeWorktree',
        level: 'debug',
        context: { epicRef: target.ref, repoDir: target.repoDir, worktreePath },
      });
      return escalated(`could not reproduce the refresh conflict on ${branch} (${String(err)}); refresh conflict: ${detail}`);
    }

    this.liveWorktrees.add(worktreePath);
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
    this.deps.fireAndForget(() => turn()
      .then(() => retry())
      .catch(async (err) => {
        await escalate(target.ref, `refresh re-attempt after the corrective turn failed for ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }), { op: 'epicRefresh.resolveTurn', level: 'error', context: { epicRef: target.ref } });
    return { status: 'dispatched' };
  }

  /** Best-effort: archive the Resolved Prompt (under Attempt 1 while the Epic has none) and record it on the Epic's latest Attempt, else in the Epic's merge-event log. */
  private async archiveAndRecord(target: EpicRefreshResolveTarget, prompt: string): Promise<void> {
    if (target.workspaceId === undefined) return;
    try {
      const owner = { workspaceId: target.workspaceId, epicRef: target.ref };
      const attempt = (await this.deps.attempts.listForEpic(owner)).at(-1);
      const archived = await this.deps.archive?.appendResolutionPrompt(owner, attempt?.number ?? 1, 'epic-refresh', 1, prompt);
      if (!attempt) {
        if (archived) await this.deps.epicMergeEvents.append(target.workspaceId, target.ref, { step: 'resolver-prompt', kind: 'refresh', attempt: 1, ...archived });
        return;
      }
      this.deps.onAttemptEvent?.(
        await this.deps.attempts.appendEvent(attempt.id, { type: 'lifecycle', payload: { event: 'epic-resolve', kind: 'refresh', ...archived } }),
      );
    } catch (err) {
      logger.warn('epic refresh resolver prompt not recorded', { epicRef: target.ref, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async runEpicRefreshResolveTurn(args: {
    target: EpicRefreshResolveTarget;
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
        const drive = this.deps.criticDrive;
        const resolver = resolveEpicResolverPrompts(await this.deps.getWorkspace?.(args.target.workspaceId), this.deps.getConfig());
        const prompt = renderEpicRefreshPrompt(resolver.refreshPrompt, resolver.fragments, {
          defaultBranch: args.target.defaultBranch,
          branch: args.branch,
          detail: args.conflictDetail,
          worktreePath: args.worktreePath,
        });
        await this.archiveAndRecord(args.target, prompt);
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
      this.liveWorktrees.delete(args.worktreePath);
      await bestEffort(() => Git.removeWorktree(args.target.repoDir, args.worktreePath), {
        op: 'runner.runEpicRefreshResolveTurn.removeWorktree',
        level: 'debug',
        context: { epicRef: args.target.ref, repoDir: args.target.repoDir, worktreePath: args.worktreePath },
      });
    }
  }
}
