import type { TrackerRef } from '../tracker/adapter.js';
import { Git } from './git.js';
import { adapterFor, adapterVersion } from './harness/registry.js';
import { collectUsage, toolCallName } from './usage.js';
import { epicFixTexts } from '../domain/epic-fix-prompt.js';
import type { PromptLibrary } from '../domain/prompt-library-store.js';
import { composeEpicResolvePrompt } from './prompt-assembly.js';
import { logger } from '../logger.js';
import { integrationBranchName } from './epic-coordinator.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import type { RunnerEvents } from './runner.js';
import type { ActiveRuns } from './active-runs.js';
import type { TaskArchive } from '../archive/task-archive.js';
import type { AppConfig } from '../config.js';
import type { AttemptRow, WorkspaceRow } from '../db/schema.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SessionStore } from '../domain/sessions.js';
import type { RoutingService } from '../domain/routing.js';
import { resolveEpicResolverPrompts } from '../domain/setting-override.js';
import { pricesForHarness } from '../domain/pricing.js';
import { runTimedCriticDrive, type CriticHarnessDrive } from '../verification/critic.js';
import type { AgentDriveRequest, AgentDriveResult, EpicSubject } from './workflow-engine.js';

export const EPIC_REFRESH_RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;

export interface EpicVerificationResolutionInput {
  workspaceId: number;
  epicRef: TrackerRef;
  title?: string;
  body?: string;
  url?: string;
  repoDir: string;
  worktreePath: string;
  attempt: AttemptRow;
  verifiedHeadOid: string;
  verificationReason: string;
  continuationSessionId?: string;
  continuationSessionRowId?: number;
}

export type VerificationEvents = Pick<RunnerEvents, 'onAttemptEvent' | 'onAttemptLogEvent' | 'onCriticLogEvent'>;

type VerifierWorkspace = Pick<
  WorkspaceRow,
  | 'epicPreMergeCommands' | 'epicPreMergeCritics'
  | 'mergeEpicRefreshPrompt' | 'verifyEpicResolveSuffix'
>;

export interface VerificationCoordinatorDeps {
  routing: Pick<RoutingService, 'epicRoute'>;
  attempts: AttemptStore;
  sessionStore: SessionStore;
  activeRuns: ActiveRuns;
  events: VerificationEvents;
  getConfig: () => AppConfig;
  getWorkspace: ((workspaceId: number | null) => Promise<VerifierWorkspace | undefined>) | undefined;
  criticDrive: CriticHarnessDrive;
  archive?: TaskArchive | undefined;
  promptLibrary: PromptLibrary;
}

export class VerificationCoordinator {
  constructor(private readonly deps: VerificationCoordinatorDeps) {}

  async resolveEpicVerification(input: EpicVerificationResolutionInput): Promise<void> {
    const config = this.deps.getConfig();
    const resolver = resolveEpicResolverPrompts(await this.deps.getWorkspace?.(input.workspaceId), config);
    const branch = integrationBranchName(input.epicRef);
    const route = await this.deps.routing.epicRoute(input.workspaceId, input.epicRef);
    if (!route.ok) throw new Error(`${route.reason} It cannot run Epic verification resolution.`);
    const { harness: harnessId, model, config: harness } = route;
    const worktreePath = input.worktreePath;

    const step = await this.deps.attempts.createStep(input.attempt.id, { type: 'implementation' });
    await this.deps.attempts.updateStep(step.id, { state: 'running', startedAt: Date.now() });
    const library = await epicFixTexts(this.deps.promptLibrary);
    const wsSuffix = resolver.resolveSuffix !== config.verify.epic.resolveSuffix;
    const prompt = composeEpicResolvePrompt({
      resolvePrompt: library.resolvePrompt,
      resolveSuffix: wsSuffix ? resolver.resolveSuffix : library.resolveSuffix,
      prompts: this.deps.promptLibrary.enginePrompts(),
      epic: { ref: String(input.epicRef), title: input.title ?? `Epic #${input.epicRef}`, body: input.body ?? '', url: input.url ?? '' },
      reason: input.verificationReason,
      branch,
    });
    const archived = await this.deps.archive?.appendResolutionPrompt({ workspaceId: input.workspaceId, epicRef: input.epicRef }, input.attempt.number, 'epic-resolve', 1, prompt);
    await this.deps.attempts.appendEvent(input.attempt.id, { type: 'lifecycle', payload: { event: 'epic-resolve', kind: 'verification', ...archived } }).then((event) => this.deps.events.onAttemptEvent?.(event)).catch((err: unknown) => {
      logger.warn('epic-resolve event failed', { attemptId: input.attempt.id, error: err instanceof Error ? err.message : String(err) });
    });
    const toolCalls = this.deps.activeRuns.getToolCallTotals(input.attempt.id) ?? await this.deps.attempts.listToolCalls(input.attempt.id);
    this.deps.activeRuns.setToolCallTotals(input.attempt.id, toolCalls);
    const onUpdate = (update: { sessionUpdate: string; [key: string]: unknown }): void => {
      const seq = this.deps.activeRuns.nextProgressSequence(input.attempt.id);
      this.deps.events.onAttemptLogEvent?.({
        id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
        attemptId: input.attempt.id,
        seq,
        ts: Date.now(),
        type: 'session_update',
        payload: update,
      });
      if (update.sessionUpdate !== 'tool_call') return;
      const name = toolCallName(update, (payload) => adapterFor(harnessId).usage?.toolName(payload) ?? null);
      toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
    };
    await this.deps.attempts.update(input.attempt.id, {
      priceTable: JSON.stringify(pricesForHarness(harness)),
      ...(input.continuationSessionId && input.continuationSessionRowId !== undefined ? { sessionId: input.continuationSessionId, sessionRowId: input.continuationSessionRowId } : {}),
    });
    try {
      const drive = this.deps.criticDrive;
      const result = await runTimedCriticDrive(drive, {
        harness,
        harnessId,
        model,
        cwd: worktreePath,
        prompt,
        timeoutMs: EPIC_REFRESH_RESOLVE_TIMEOUT_MS,
        onUpdate,
        ...(input.continuationSessionId ? { continueSessionId: input.continuationSessionId } : {}),
        onSessionCreated: async (sessionId, initialize) => {
          const session = await this.deps.sessionStore.recordDispatch({
            harness: harnessId,
            harnessSessionId: sessionId,
            model,
            cwd: worktreePath,
            workspaceId: input.workspaceId,
            mcpTemplates: [],
            capabilities: initialize,
            adapterVersion: adapterVersion(harnessId),
            now: Date.now(),
          });
          await this.deps.attempts.update(input.attempt.id, { sessionId, sessionRowId: session.id });
          await this.deps.attempts.updateStep(step.id, { logLocator: `session:${session.id}` });
        },
      }, (ms) => this.deps.attempts.addAgentDuration(input.attempt.id, ms));
      if (await Git.currentBranch(worktreePath) !== branch) {
        throw new Error(`Epic verification resolver left '${branch}'`);
      }
      if (await Git.isDirty(worktreePath)) {
        throw new Error('Epic verification resolver left uncommitted changes');
      }
      if (await Git.revParse(worktreePath, 'HEAD') === input.verifiedHeadOid) {
        throw new Error('Epic verification resolver did not commit a change');
      }
      await this.deps.attempts.replaceToolCalls(input.attempt.id, toolCalls);
      const usage = collectUsage({
        harnessId,
        harness,
        cwd: worktreePath,
        sessionId: result.sessionId ?? null,
        ...(result.usage ? { promptResult: { usage: result.usage } } : {}),
        prices: pricesForHarness(harness),
      });
      if (usage) await this.deps.attempts.updateWithFrozenCost(input.attempt.id, { usage: JSON.stringify(usage) });
      await this.deps.attempts.updateStep(step.id, { state: 'passed', endedAt: Date.now() });
    } catch (error) {
      await this.deps.attempts.replaceToolCalls(input.attempt.id, toolCalls);
      await this.deps.attempts.updateStep(step.id, { state: 'failed', endedAt: Date.now() });
      throw error;
    } finally {
      this.deps.activeRuns.deleteToolCallTotals(input.attempt.id);
    }
  }
  async runEpicAgentTurn(req: AgentDriveRequest<EpicSubject>): Promise<AgentDriveResult> {
    const { task, run } = req;
    if (!task || !run) throw new Error('an Epic agent turn needs its Epic and Attempt');
    const { workspaceId, epicRef } = task;
    const { harness, harnessId, model, cwd } = req;
    const branch = integrationBranchName(epicRef);
    const archived = await this.deps.archive?.appendResolutionPrompt({ workspaceId, epicRef }, run.number, 'epic-resolve', req.stepRowId ?? 1, req.prompt);
    await this.deps.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'epic-resolve', kind: 'verification', ...archived } }).then((event) => this.deps.events.onAttemptEvent?.(event)).catch((err: unknown) => {
      logger.warn('epic-resolve event failed', { attemptId: run.id, error: err instanceof Error ? err.message : String(err) });
    });
    const toolCalls = this.deps.activeRuns.getToolCallTotals(run.id) ?? await this.deps.attempts.listToolCalls(run.id);
    this.deps.activeRuns.setToolCallTotals(run.id, toolCalls);
    const onUpdate = (update: { sessionUpdate: string; [key: string]: unknown }): void => {
      const seq = this.deps.activeRuns.nextProgressSequence(run.id);
      this.deps.events.onAttemptLogEvent?.({ id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq, attemptId: run.id, seq, ts: Date.now(), type: 'session_update', payload: update });
      if (update.sessionUpdate !== 'tool_call') return;
      const name = toolCallName(update, (payload) => adapterFor(harnessId).usage?.toolName(payload) ?? null);
      toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
    };
    await this.deps.attempts.update(run.id, { priceTable: JSON.stringify(pricesForHarness(harness)) });
    try {
      const result = await runTimedCriticDrive(this.deps.criticDrive, {
        harness,
        harnessId,
        model,
        cwd,
        prompt: req.prompt,
        timeoutMs: req.timeoutMs,
        onUpdate,
        ...(req.continueSessionId ? { continueSessionId: req.continueSessionId } : {}),
        onSessionCreated: async (sessionId, initialize) => {
          const session = await this.deps.sessionStore.recordDispatch({
            harness: harnessId,
            harnessSessionId: sessionId,
            model,
            cwd,
            workspaceId,
            mcpTemplates: [],
            capabilities: initialize,
            adapterVersion: adapterVersion(harnessId),
            now: Date.now(),
          });
          await this.deps.attempts.update(run.id, { sessionId, sessionRowId: session.id });
        },
      }, (ms) => this.deps.attempts.addAgentDuration(run.id, ms));
      if (await Git.currentBranch(cwd) !== branch) throw new Error(`Epic resolve agent left '${branch}'`);
      const usage = collectUsage({ harnessId, harness, cwd, sessionId: result.sessionId ?? null, ...(result.usage ? { promptResult: { usage: result.usage } } : {}), prices: pricesForHarness(harness) });
      if (usage) await this.deps.attempts.updateWithFrozenCost(run.id, { usage: JSON.stringify(usage) });
      return result;
    } finally {
      await this.deps.attempts.replaceToolCalls(run.id, toolCalls);
      this.deps.activeRuns.deleteToolCallTotals(run.id);
    }
  }
}
