import { Git } from './git.js';
import { adapterFor, adapterVersion } from './harness/registry.js';
import { collectUsage, toolCallName } from './usage.js';
import { logger } from '../logger.js';
import { integrationBranchName } from './epic-coordinator.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import type { RunnerEvents } from './runner.js';
import type { ActiveRuns } from './active-runs.js';
import type { TaskArchive } from '../archive/task-archive.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SessionStore } from '../domain/sessions.js';
import { pricesForHarness } from '../domain/pricing.js';
import { runTimedCriticDrive, type CriticHarnessDrive } from '../verification/critic.js';
import type { AgentDriveRequest, AgentDriveResult, EpicSubject } from './workflow-engine.js';

export type VerificationEvents = Pick<RunnerEvents, 'onAttemptEvent' | 'onAttemptLogEvent'>;

export interface VerificationCoordinatorDeps {
  attempts: AttemptStore;
  sessionStore: SessionStore;
  activeRuns: ActiveRuns;
  events: VerificationEvents;
  criticDrive: CriticHarnessDrive;
  archive?: TaskArchive | undefined;
}

export class VerificationCoordinator {
  constructor(private readonly deps: VerificationCoordinatorDeps) {}

  async runEpicAgentTurn(req: AgentDriveRequest<EpicSubject>): Promise<AgentDriveResult> {
    const { task, run } = req;
    if (!task || !run) throw new Error('an Epic agent turn needs its Epic and Attempt');
    const { workspaceId, epicRef } = task;
    const { harness, harnessId, model, cwd } = req;
    const branch = integrationBranchName(epicRef);
    const archived = await this.deps.archive?.appendResolutionPrompt({ workspaceId, epicRef }, run.number, 'epic-resolve', req.stepRunId ?? 1, req.prompt);
    await this.deps.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'epic-resolve', kind: 'verification', ...archived } }).then((event) => this.deps.events.onAttemptEvent?.(event)).catch((err: unknown) => {
      logger.warn('epic-resolve event failed', { attemptId: run.id, error: err instanceof Error ? err.message : String(err) });
    });
    const toolCalls = this.deps.activeRuns.getToolCallTotals(run.id) ?? await this.deps.attempts.listToolCalls(run.id);
    this.deps.activeRuns.setToolCallTotals(run.id, toolCalls);
    const onUpdate = (update: { sessionUpdate: string; [key: string]: unknown }): void => {
      const seq = this.deps.activeRuns.nextProgressSequence(run.id);
      this.deps.events.onAttemptLogEvent?.({ id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq, attemptId: run.id, seq, ts: Date.now(), ...(req.stepRunId !== undefined ? { stepRunId: req.stepRunId } : {}), type: 'session_update', payload: update });
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
