import type { TrackerRef } from '../tracker/adapter.js';
import { Git } from './git.js';
import { adapterFor, adapterVersion } from './harness/registry.js';
import { collectUsage, toolCallName } from './usage.js';
import { driveFields, fillTemplate } from './prompt-template.js';
import { logger } from '../logger.js';
import { indexWorktree } from './code-index.js';
import { integrationBranchName } from './epic-coordinator.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import type { RunnerEvents } from './runner.js';
import type { ActiveRuns } from './active-runs.js';
import { criticPromptKey, type TaskArchive } from '../archive/task-archive.js';
import type { TranscriptCapture } from './transcript-capture.js';
import type { AppConfig, HarnessConfig, TaskVerificationCritic, VerificationCommand } from '../config.js';
import type { TaskRow, AttemptRow, WorkspaceRow, StepRow, VerificationAttemptRow } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SessionStore } from '../domain/sessions.js';
import type { TaskService } from '../domain/tasks.js';
import type { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { resolvePromptFragments, resolveVerifiers, type ResolvedVerifiers } from '../domain/setting-override.js';
import { pricesForHarness } from '../domain/pricing.js';
import { runCommandVerifier, commandAttemptToInput, type CommandSpawn } from '../verification/command-verifier.js';
import { runCritic, runTimedCriticDrive, criticAttemptToInput, type CriticHarnessDrive } from '../verification/critic.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import type { SpanContext } from '@opentelemetry/api';
import type { FireAndForget } from '../error-handling.js';

export const EPIC_REFRESH_RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;

const VERIFICATION_OUTPUT_FLUSH_INTERVAL_MS = 400;
const VERIFICATION_OUTPUT_FLUSH_BYTES = 8 * 1024;

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
  resolvePrompt: string;
  continuationSessionId?: string;
  continuationSessionRowId?: number;
}

export type LifecycleRecorder = (type: 'lifecycle', payload: unknown) => void;

export type VerificationEvents = Pick<RunnerEvents, 'onAttemptEvent' | 'onAttemptLogEvent' | 'onCriticLogEvent'>;

type VerifierWorkspace = Pick<
  WorkspaceRow,
  | 'taskPreMergeCommands' | 'taskPreMergeCritics'
  | 'taskPostMergeCommands' | 'taskPostMergeCritics'
  | 'epicPreMergeCommands' | 'epicPreMergeCritics'
  | 'promptFragmentReadOnlyRestraint'
>;

export interface VerificationCoordinatorDeps {
  taskService: TaskService;
  attempts: AttemptStore;
  verificationAttempts: VerificationAttemptStore;
  sessionStore: SessionStore;
  transcripts: TranscriptCapture;
  activeRuns: ActiveRuns;
  events: VerificationEvents;
  getConfig: () => AppConfig;
  getWorkspace: ((workspaceId: number | null) => Promise<VerifierWorkspace | undefined>) | undefined;
  criticDrive: CriticHarnessDrive;
  commandSpawn: CommandSpawn;
  fireAndForget: FireAndForget;
  archive?: TaskArchive | undefined;
  urlFor: (task: TaskRow) => string | null;
  worktreePathForTask: (task: TaskRow) => string;
  latestAttemptFor: (task: Pick<TaskRow, 'id'>) => Promise<AttemptRow>;
  updateStep: (
    taskId: number,
    id: number,
    patch: Parameters<AttemptStore['updateStep']>[1],
  ) => Promise<Awaited<ReturnType<AttemptStore['updateStep']>>>;
}

const DEFAULT_VERIFIER_WORKSPACE: VerifierWorkspace = {
  taskPreMergeCommands: null,
  taskPreMergeCritics: null,
  taskPostMergeCommands: null,
  taskPostMergeCritics: null,
  epicPreMergeCommands: null,
  epicPreMergeCritics: null,
  promptFragmentReadOnlyRestraint: null,
};

export class VerificationCoordinator {
  constructor(private readonly deps: VerificationCoordinatorDeps) {}

  /** A task's effective verifiers, with the Workspace's own overrides applied over the global defaults. */
  private async resolveTaskVerifiers(task: TaskRow): Promise<{ config: AppConfig; resolvedTask: ResolvedVerifiers['task']; fragments: AppConfig['promptFragments'] }> {
    const config = this.deps.getConfig();
    const ws = await this.deps.getWorkspace?.(task.workspaceId);
    const { task: resolvedTask } = resolveVerifiers(ws ?? DEFAULT_VERIFIER_WORKSPACE, config);
    return { config, resolvedTask, fragments: resolvePromptFragments(ws ?? DEFAULT_VERIFIER_WORKSPACE, config) };
  }

  private buildCriticInput(task: TaskRow, configuredCritic: TaskVerificationCritic): { prompt: string; model: string; harness?: string } {
    return {
      prompt: task.trackerRef == null ? configuredCritic.noIssuePrompt : configuredCritic.issuePrompt,
      model: configuredCritic.model,
      ...(configuredCritic.harness ? { harness: configuredCritic.harness } : {}),
    };
  }

  private resolveCriticHarness(config: AppConfig, criticHarnessId: string): HarnessConfig {
    const criticHarness = config.harnesses[criticHarnessId as keyof typeof config.harnesses];
    if (!criticHarness) throw new DomainError('validation', `critic harness '${criticHarnessId}' is not configured`);
    return criticHarness;
  }

  /** The harness rarely has its transcript or usage flushed by the session-end
   * boundary, so both are resolved off the hot path. */
  private captureCriticArtifacts(input: {
    persisted: VerificationAttemptRow;
    sessionId: string | null;
    transcriptPath: string | null;
    criticHarnessId: string;
    criticHarness: HarnessConfig;
    cwd: string;
  }): void {
    const { persisted, sessionId, transcriptPath, criticHarnessId, criticHarness, cwd } = input;
    if (!sessionId) return;
    if (transcriptPath === null) {
      this.deps.fireAndForget(() => this.deps.transcripts.captureCriticTranscript({
        attemptId: persisted.id,
        sessionId,
        harnessId: criticHarnessId,
        sessionLogDir: criticHarness.sessionLogDir,
      }), { op: 'verification.captureCriticTranscript', level: 'warn', context: { attemptId: persisted.id } });
    }
    this.deps.fireAndForget(() => this.deps.transcripts.captureCriticUsage({
      attemptId: persisted.id,
      sessionId,
      harnessId: criticHarnessId,
      cwd,
    }), { op: 'verification.captureCriticUsage', level: 'warn', context: { attemptId: persisted.id } });
  }

  private verificationOutputRelay(attemptId: number, mechanism: 'command' | 'critic', command: string | null): { push: (chunk: string) => void; flush: () => void } {
    let pending = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending) return;
      const text = pending;
      pending = '';
      const seq = this.deps.activeRuns.nextProgressSequence(attemptId);
      this.deps.events.onAttemptLogEvent?.({
        id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
        attemptId,
        seq,
        ts: Date.now(),
        type: 'session_update',
        payload: { sessionUpdate: 'verification_output', mechanism, command, content: { type: 'text', text } },
      });
    };
    return {
      push: (chunk) => {
        pending += chunk;
        if (pending.length >= VERIFICATION_OUTPUT_FLUSH_BYTES) flush();
        else if (!timer) timer = setTimeout(flush, VERIFICATION_OUTPUT_FLUSH_INTERVAL_MS);
      },
      flush,
    };
  }

  private relayCriticUpdateAsBuilderEvent(attemptId: number): (update: { sessionUpdate: string; [key: string]: unknown }) => void {
    return (update) => {
      const seq = this.deps.activeRuns.nextCriticLogSequence(attemptId);
      this.deps.events.onCriticLogEvent?.({
        id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
        attemptId,
        seq,
        ts: Date.now(),
        type: 'session_update',
        payload: update,
      });
    };
  }

  private async openLiveVerificationStep(
    task: TaskRow,
    command: VerificationCommand,
    record: LifecycleRecorder,
  ): Promise<{ timelineAttempt: AttemptRow; timelineStep: StepRow; label: string }> {
    const label = [command.command, ...command.args].join(' ').trim();
    const timelineAttempt = await this.deps.latestAttemptFor(task);
    const timelineStep = await this.deps.attempts.createStep(timelineAttempt.id, { type: 'verification', command: command.command });
    await this.deps.updateStep(task.id, timelineStep.id, { state: 'running', startedAt: Date.now() });
    record('lifecycle', { event: 'verification-started', mechanism: 'command', command: label });
    return { timelineAttempt, timelineStep, label };
  }

  private async noVerifiedHeadVerdict(
    task: TaskRow,
    mechanism: 'command' | 'critic',
    record: LifecycleRecorder,
  ): Promise<VerifierVerdict> {
    const attempt = await this.deps.latestAttemptFor(task);
    const persisted = await this.deps.verificationAttempts.append(attempt.id, {
      mechanism,
      inputOid: '',
      verdict: 'inconclusive',
      summary: 'no committed branch head to verify',
      output: '',
    });
    const timeline = await this.deps.attempts.createStep(attempt.id, {
      type: mechanism === 'command' ? 'verification' : 'review',
      logLocator: `verification_attempt:${persisted.id}`,
    });
    await this.deps.updateStep(task.id, timeline.id, {
      state: 'failed', verdict: 'inconclusive', startedAt: persisted.ts, endedAt: Date.now(),
    });
    record('lifecycle', { event: 'verification', mechanism, verdict: 'inconclusive' });
    return { verifier: mechanism, verdict: 'inconclusive' };
  }

  async criticEnabledFor(task: TaskRow): Promise<boolean> {
    const { resolvedTask } = await this.resolveTaskVerifiers(task);
    return resolvedTask.preMerge.critics.length > 0;
  }

  async runVerification(
    task: TaskRow,
    run: AttemptRow,
    head: string | null,
    signal: AbortSignal,
    record: LifecycleRecorder,
    parent: SpanContext,
    criticEnabled = true,
    startAt: 'commands' | 'critics' = 'commands',
  ): Promise<{ decision: VerificationDecision; ran: boolean }> {
    run = await this.deps.attempts.get(run.id);
    const { config, resolvedTask, fragments } = await this.resolveTaskVerifiers(task);
    const { commands, critics } = resolvedTask.preMerge;

    const verdicts: VerifierVerdict[] = [];
    const oid = head;

    for (const command of startAt === 'critics' ? [] : commands) {
      if (!oid) {
        verdicts.push(await this.noVerifiedHeadVerdict(task, 'command', record));
      } else {
        const { timelineAttempt, timelineStep, label } = await this.openLiveVerificationStep(task, command, record);
        const relay = this.verificationOutputRelay(run.id, 'command', label);
        const outputLog = (await this.deps.archive?.verificationOutputLog(task, run.number, 'pre-merge', command.id)) ?? null;
        const attempt = await runCommandVerifier({
          outputLog,
          cwd: run.branch ? this.deps.worktreePathForTask(task) : task.workingDir,
          verifiedHeadOid: oid,
          command,
          signal,
          parent,
          attributes: { 'task.id': task.id, 'attempt.id': run.id },
          onOutput: relay.push,
          spawn: this.deps.commandSpawn,
        });
        relay.flush();
        const persisted = await this.deps.verificationAttempts.append(timelineAttempt.id, commandAttemptToInput(attempt));
        await this.deps.updateStep(task.id, timelineStep.id, {
          state: attempt.verdict === 'pass' ? 'passed' : 'failed',
          verdict: attempt.verdict,
          logLocator: `verification_attempt:${persisted.id}`,
          endedAt: Date.now(),
        });
        record('lifecycle', {
          event: 'verification',
          mechanism: 'command',
          verdict: attempt.verdict,
          summary: attempt.summary,
        });
        verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
        if (attempt.verdict !== 'pass') break;
      }
    }

    const criticFeedback: string[] = [];
    if (criticEnabled && verdicts.every((entry) => entry.verdict === 'pass')) {
      const criticCwd = run.branch ? this.deps.worktreePathForTask(task) : task.workingDir;
      if (run.branch && critics.length > 0) await indexWorktree(criticCwd);
      const dirty = run.branch && critics.length > 0 ? await Git.isDirty(criticCwd).catch(() => false) : false;
      await Promise.all(critics.map(async (configuredCritic, index) => {
      const critic = this.buildCriticInput(task, configuredCritic);
      if (!oid) {
        verdicts.push(await this.noVerifiedHeadVerdict(task, 'critic', record));
      } else {
        const criticHarnessId = critic.harness ?? task.harness;
        const criticHarness = this.resolveCriticHarness(config, criticHarnessId);
        const baseOid =
          run.branch && run.baseBranch
            ? await Git.mergeBase(task.workingDir, run.baseBranch, run.branch).catch(() => null)
            : null;
        const timelineAttempt = await this.deps.latestAttemptFor(task);
        const timelineStep = await this.deps.attempts.createStep(timelineAttempt.id, { type: 'review' });
        await this.deps.updateStep(task.id, timelineStep.id, { state: 'running', startedAt: Date.now() });
        record('lifecycle', { event: 'verification-started', mechanism: 'critic', model: critic.model });
        const archive = this.deps.archive?.criticStep(task, timelineAttempt.number, 'pre-merge', String(timelineStep.id));
        const promptKey = archive ? criticPromptKey('pre-merge', String(timelineStep.id)) : null;
        const attempt = await runCritic({
          cwd: criticCwd,
          verifiedHeadOid: oid,
          ...(baseOid ? { baseOid } : {}),
          ...(dirty ? { dirty } : {}),
          critic,
          fragments,
          timeoutMs: configuredCritic.timeoutSeconds * 1000,
          fields: driveFields(task, this.deps.urlFor),
          harness: criticHarness,
          harnessId: criticHarnessId,
          parent,
          attributes: { 'task.id': task.id, 'attempt.id': run.id },
          drive: this.deps.criticDrive,
          ...(archive ? { archive } : {}),
          onUpdate: this.relayCriticUpdateAsBuilderEvent(run.id),
          onAgentDurationMs: (ms) => this.deps.attempts.addAgentDuration(run.id, ms),
        });
        const persisted = await this.deps.verificationAttempts.append(timelineAttempt.id, { ...criticAttemptToInput(attempt), promptKey });
        this.captureCriticArtifacts({
          persisted,
          sessionId: attempt.sessionId,
          transcriptPath: attempt.transcriptPath,
          criticHarnessId,
          criticHarness,
          cwd: criticCwd,
        });
        await this.deps.updateStep(task.id, timelineStep.id, {
          state: attempt.verdict === 'pass' ? 'passed' : 'failed',
          verdict: attempt.verdict,
          logLocator: `verification_attempt:${persisted.id}`,
          endedAt: Date.now(),
        });
        record('lifecycle', {
          event: 'verification',
          mechanism: 'critic',
          verdict: attempt.verdict,
          summary: attempt.summary,
        });
        verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
        if (attempt.verdict !== 'pass') {
          criticFeedback.push([
            `Task critic ${index + 1} (${attempt.verdict}): ${attempt.summary}`,
            attempt.output,
          ].filter(Boolean).join('\n'));
        }
      }
      }));
    }

    const decision = combineVerdicts(verdicts);
    return {
      decision: criticFeedback.length > 0
        ? { ...decision, reason: `${decision.reason}\n\n${criticFeedback.join('\n\n')}` }
        : decision,
      ran: verdicts.length > 0,
    };
  }

  async verificationFailTurn(
    task: TaskRow,
    decision: VerificationDecision,
    record: LifecycleRecorder,
  ): Promise<{ kind: 'actionable-fail'; reason: string; output: string }> {
    const attemptRow = await this.deps.latestAttemptFor(task);
    const attempts = await this.deps.verificationAttempts.list(attemptRow.id);
    const criticOutput = attempts
      .filter((attempt) => attempt.mechanism === 'critic' && attempt.verdict !== 'pass')
      .map((attempt, index) => [
        `Task critic ${index + 1} (${attempt.verdict}): ${attempt.summary}`,
        attempt.output,
      ].filter(Boolean).join('\n'))
      .join('\n\n');
    const output = criticOutput || attempts[attempts.length - 1]?.output || '';
    record('lifecycle', { event: 'verification-actionable-fail', reason: decision.reason });
    const reason = decision.outcome === 'block' ? decision.reason : `verification ${decision.outcome}: ${decision.reason}`;
    return { kind: 'actionable-fail', reason, output };
  }

  async resolveEpicVerification(input: EpicVerificationResolutionInput): Promise<void> {
    const config = this.deps.getConfig();
    const branch = integrationBranchName(input.epicRef);
    const host = (await this.deps.taskService.list({ state: 'working' })).find((task) => task.baseBranch === branch);
    const harnessId = host?.harness ?? config.defaults.harness;
    const harness = config.harnesses[harnessId as keyof AppConfig['harnesses']];
    if (!harness) throw new Error(`harness '${harnessId}' is not configured for Epic verification resolution`);
    const model = host?.model ?? harness.defaultModel;
    const worktreePath = input.worktreePath;

    const step = await this.deps.attempts.createStep(input.attempt.id, { type: 'implementation' });
    await this.deps.attempts.updateStep(step.id, { state: 'running', startedAt: Date.now() });
    const prompt = [
      input.resolvePrompt
        .replaceAll('{ref}', String(input.epicRef))
        .replaceAll('{title}', input.title ?? `Epic #${input.epicRef}`)
        .replaceAll('{description}', input.body ?? '')
        .replaceAll('{url}', input.url ?? ''),
      '',
      '## Failing Epic verification',
      input.verificationReason,
      '',
      fillTemplate(config.verify.epic.resolveSuffix, { branch }),
    ].join('\n');
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
      prompt,
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
}
