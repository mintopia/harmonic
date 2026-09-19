import type { ChildProcess } from 'node:child_process';
import { Git } from './git.js';
import { GitError } from '../domain/errors.js';
import { bestEffort, fireAndForget } from '../error-handling.js';
import { classifyGitFailure, type GitCircuitBreaker } from './git-failure.js';
import { adapterFor } from './harness/registry.js';
import { readProcStartToken } from './process-reaper.js';
import { observedModelMismatch, activityLine, toolCallName, type AttemptUsage } from './usage.js';
import type { LiveUsageTailer } from './live-usage-tailer.js';
import type { UsageSampler } from './usage-sampler.js';
import { GuardrailSupervisor } from './guardrail-supervisor.js';
import { ActiveRuns, type ActiveRun } from './active-runs.js';
import { codeIndexRepoGuidance, promptForTask } from './prompt-template.js';
import { indexWorktree } from './code-index.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import type { VerificationCoordinator } from './verification-coordinator.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { AcpDriver, AcpPromptTimeoutError, type AcpInitializeResult, type PromptResult } from '../acp/driver.js';
import { AcpConnectionClosedError } from '../acp/connection.js';
import { parsePermissionRequest } from '../acp/permission-request.js';
import type { SessionStore } from '../domain/sessions.js';
import { type DeterministicContinuation } from '../domain/session-continuation.js';
import { repoKey } from './repo-lock.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SettleProjection, DispositionKind } from '../domain/attempt-settle.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveScoped, resolveTaskPrompt } from '../domain/setting-override.js';
import { SessionContinuation, type PersistSessionContext } from './session-continuation.js';
import { MergeCoordinator, BaseBranchUnresolved, EpicBaseNotReady } from './merge-coordinator.js';
import type { GuardrailEventStore } from '../domain/guardrail-events.js';
import { toProgressEvents } from '../domain/guardrail-progress.js';
import type { ProgressEvent } from '../domain/stall-detector.js';
import { logger } from '../logger.js';
import { runMergePolicy } from './merge-policy.js';
import type { SpanContext } from '@opentelemetry/api';
import type { RunnerEvents, RunnerOptions, Workspace } from './runner.js';

const STDERR_TAIL_CAP = 8000;

interface HealContext {
  reason: string;
  output: string;
  attempt: number;
  continuation: DeterministicContinuation;
  condensedContext: string | null;
}

type TurnOutcome =
  | { kind: 'terminal' }
  | { kind: 'actionable-fail'; reason: string; output: string };

type RunEventRecorder = (type: 'permission_request' | 'lifecycle', payload: unknown) => void;

interface TurnRuntime {
  active: ActiveRun;
  driver: AcpDriver;
  guardrails: GuardrailSupervisor;
  listeners: TurnListeners;
  finalize: () => Promise<void>;
}

/** State owned by one drive, released when that drive ends. */
export class TurnState {
  sessionInit: AcpInitializeResult | undefined;
  sessionRowId: number | undefined;
  toolCallFlushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly attemptAtStart: AttemptRow,
    readonly toolCalls: Map<string, number>,
    readonly progressEvents: ProgressEvent[],
  ) {}

  clearTimer(): void {
    if (this.toolCallFlushTimer) clearInterval(this.toolCallFlushTimer);
    this.toolCallFlushTimer = undefined;
  }
}

interface TurnListenerRuntime {
  active: ActiveRun;
  driver: AcpDriver;
  guardrails: GuardrailSupervisor;
}

/** ACP callbacks for a single drive. Runner owns the reconnect-visible maps. */
export class TurnListeners {
  private runtime: TurnListenerRuntime | undefined;
  stoppedShort: string | null = null;

  constructor(
    private readonly input: {
      task: TaskRow;
      run: AttemptRow;
      state: TurnState;
      autoDriven: boolean;
      events: RunnerEvents;
      record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void;
      nextProgressSequence: () => number;
      outstandingAction: (event: ProgressEvent) => void;
      completeOutstandingAction: (event: ProgressEvent) => void;
    },
  ) {}

  setRuntime(runtime: TurnListenerRuntime): void {
    this.runtime = runtime;
  }

  onInitialize = (result: AcpInitializeResult): void => {
    this.input.state.sessionInit = result;
  };

  onSessionUpdate = (update: { sessionUpdate: string; [key: string]: unknown }, replay: boolean): void => {
    if (replay) return;
    const runtime = this.runtime;
    const { task, run, state } = this.input;
    const seq = this.input.nextProgressSequence();
    this.input.events.onAttemptLogEvent?.({
      id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
      attemptId: run.id,
      seq,
      ts: Date.now(),
      type: 'session_update',
      payload: update,
    });
    const progress = toProgressEvents([{ seq, type: 'session_update', payload: update }]);
    if (progress.length > 0) {
      const event = progress[0]!;
      if (event.kind === 'action') this.input.outstandingAction(event);
      else if (event.kind === 'result' || event.kind === 'error') this.input.completeOutstandingAction(event);
      state.progressEvents.push(event);
      if (state.progressEvents.length > 64) state.progressEvents.shift();
    }
    const line = activityLine(update);
    if (line && runtime) runtime.active.activity = line;
    if (update.sessionUpdate === 'tool_call') {
      const name = toolCallName(update, (payload) => adapterFor(task.harness).usage?.toolName(payload) ?? null);
      state.toolCalls.set(name, (state.toolCalls.get(name) ?? 0) + 1);
    }
    runtime?.guardrails.observeTool(update);
  };

  onRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method !== 'session/request_permission') return null;
    const request = parsePermissionRequest(params);
    if (!request) {
      logger.warn('acp: rejected malformed permission request', { attemptId: this.input.run.id });
      return { outcome: 'cancelled' };
    }
    const options = request.options;
    const grant = () => {
      const pick =
        options.find((option) => option.kind === 'allow_always') ??
        options.find((option) => option.kind === 'allow_once') ??
        options[0];
      const outcome = pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
      this.input.record('permission_request', { request, outcome });
      return { outcome };
    };
    if (!this.input.autoDriven) return grant();
    this.stoppedShort = `permission request declined (no human on this turn): ${request.toolCall.title ?? 'permission request'}`;
    const outcome = { outcome: 'cancelled' };
    this.input.record('permission_request', { request, outcome });
    this.runtime?.driver.cancel();
    return { outcome };
  };
}

export interface TurnDriverDeps {
  taskService: TaskService;
  attempts: AttemptStore;
  sessionStore: SessionStore;
  guardrailEvents: GuardrailEventStore;
  usage: UsageSampler;
  tailer: LiveUsageTailer;
  getConfig: () => AppConfig;

  activeRuns: ActiveRuns;
  mergeCoordinator: MergeCoordinator;
  verification: VerificationCoordinator;
  sessionContinuation: SessionContinuation;

  events: RunnerEvents;
  autoDrive: AutoDrive | undefined;
  keys: RunnerOptions['keys'];
  getWorkspace: RunnerOptions['getWorkspace'];
  postMerge: RunnerOptions['postMerge'];
  gitBreaker: GitCircuitBreaker | undefined;
  onGloballyPaused: ((taskId: number) => Promise<void>) | undefined;
  spendPollMs: number;
  spendGraceMs: number;

  mcpUrl: () => string | null;
  isShuttingDown: () => boolean;
  prepareWorkspace: (task: TaskRow, run: AttemptRow, resume?: boolean) => Promise<Workspace>;
  finalizeWorkspace: (task: TaskRow, run: AttemptRow, attemptNumber: number, workspace: Workspace) => Promise<void>;
  spawnHarness: (
    task: TaskRow, harness: HarnessConfig, cwd: string,
    extraEnv: Record<string, string>, unattended: boolean,
  ) => ChildProcess;
  updateStep: (
    taskId: number, id: number, patch: Parameters<AttemptStore['updateStep']>[1],
  ) => Promise<Awaited<ReturnType<AttemptStore['updateStep']>>>;
  pauseIfGloballyPaused: (taskId: number) => Promise<boolean>;
  latestAttemptFor: (task: Pick<TaskRow, 'id'>) => Promise<AttemptRow>;
  recordRunEvent: (
    task: TaskRow, run: AttemptRow,
    type: 'permission_request' | 'lifecycle', payload: unknown,
  ) => void;
  coordinateSettle: (
    task: TaskRow, run: AttemptRow, type: DispositionKind,
    projection: SettleProjection, patch?: Partial<AttemptRow>,
  ) => Promise<void>;
  settleEscalated: (task: TaskRow, run: AttemptRow, reason: string, patch: Partial<AttemptRow>) => Promise<void>;
  settleAutoCompleted: (task: TaskRow, run: AttemptRow, patch: Partial<AttemptRow>) => Promise<void>;
  diffSnapshotFor: (
    task: TaskRow, attemptId: number,
  ) => Promise<Pick<AttemptRow, 'stat' | 'diffBaseOid' | 'diffHeadOid'>>;
  kill: (active: ActiveRun) => void;
}

export class TurnDriver {
  constructor(private readonly deps: TurnDriverDeps) {}

  async drive(task: TaskRow, run: AttemptRow, harness: HarnessConfig, parent: SpanContext): Promise<void> {
    const workspace = await this.deps.getWorkspace?.(task.workspaceId);
    const maxAttempts = resolveScoped('maxAttempts', workspace?.maxAttempts, this.deps.getConfig().maxAttempts);
    let attemptNumber = run.number;
    const budgetBase = await this.deps.attempts.budgetBase(task.id);
    let healCtx: HealContext | undefined;
    try {
      for (;;) {
      const outcome = await this.driveOnce(task, run, harness, parent, healCtx, attemptNumber);
      if (outcome.kind === 'terminal') return;
      run = await this.deps.attempts.get(run.id);
      const feedback = [outcome.reason, outcome.output].filter(Boolean).join('\n\n');
      if (attemptNumber - budgetBase >= maxAttempts) {
        await this.deps.settleEscalated(task, run, `attempt ${attemptNumber - budgetBase} of ${maxAttempts} failed: ${outcome.reason}`, { feedback });
        return;
      }
      await this.deps.attempts.finish(run.id, 'failed', Date.now(), feedback);
      const continuation = await this.deps.sessionContinuation.decideContinuation(task, run, workspace);
      attemptNumber += 1;
      const closedRunId = run.id;
      this.deps.activeRuns.releaseAttempt(closedRunId);
      const nextAttempt = await this.deps.attempts.ensureForRun(task.id, attemptNumber, Date.now());
      run = await this.deps.attempts.update(nextAttempt.id, {
        branch: run.branch,
        baseBranch: run.baseBranch,
        sessionRowId: run.sessionRowId,
        sessionId: run.sessionId,
        verifiedHeadOid: run.verifiedHeadOid,
      });
      await this.deps.attempts.setContinuation(run.id, continuation);
      healCtx = {
        reason: outcome.reason,
        output: outcome.output,
        attempt: attemptNumber - 1,
        continuation,
        condensedContext: continuation.path === 'new-session-condensed' ? await this.deps.sessionContinuation.condensedContext(run) : null,
      };
      }
    } finally {
      this.deps.activeRuns.releaseAttempt(run.id);
    }
  }

  private async driveOnce(
    task: TaskRow,
    run: AttemptRow,
    harness: HarnessConfig,
    parent: SpanContext,
    healCtx?: HealContext,
    attemptNumber = run.number,
  ): Promise<TurnOutcome> {
    const record = (type: 'permission_request' | 'lifecycle', payload: unknown) => {
      this.deps.recordRunEvent(task, run, type, payload);
    };
    if (await this.deps.pauseIfGloballyPaused(task.id)) {
      record('lifecycle', { event: 'paused' });
      return { kind: 'terminal' };
    }
    const attemptAtStart = await this.deps.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
    const toolCalls = this.deps.activeRuns.getToolCallTotals(run.id) ?? (await this.deps.attempts.listToolCalls(attemptAtStart.id));
    this.deps.activeRuns.setToolCallTotals(run.id, toolCalls);
    const progressEvents = this.deps.activeRuns.getProgressTrace(run.id) ?? [];
    this.deps.activeRuns.setProgressTrace(run.id, progressEvents);
    const turn = new TurnState(attemptAtStart, toolCalls, progressEvents);
    const flushToolCalls = async () => {
      await this.deps.attempts.replaceToolCalls(turn.attemptAtStart.id, turn.toolCalls);
    };

    const opensAttempt = (await this.deps.attempts.listSteps(turn.attemptAtStart.id)).length === 0;

    const advanceTask = async (to: 'verifying' | 'merging') => {
      const attempt = await this.deps.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
      const rows = await this.deps.attempts.listSteps(attempt.id);
      const implementation = rows.find((row) => row.type === 'implementation' && row.state === 'running');
      if (to === 'verifying' && implementation) {
        await this.deps.updateStep(task.id, implementation.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
      }
    };

    let escalating: string | null = null;
    const autoDriven = this.deps.autoDrive?.handles(task) ?? false;

    let child: ChildProcess;
    let workspace: Workspace;
    let mcpServers: unknown[] = [];
    // codex-acp can exit non-zero mid-handshake with no ACP error; the cause is
    // only on stderr. Draining the pipe also prevents backpressure.
    let stderrTail = '';
    let stderrFlushed: Promise<void> = Promise.resolve();
    let rebaseConflict = false;
    try {
      workspace = await this.deps.prepareWorkspace(task, run, healCtx !== undefined);
      if (opensAttempt && workspace.worktree) {
        const baseBranch = (await this.deps.attempts.get(run.id)).baseBranch ?? await this.deps.mergeCoordinator.resolveBaseBranch(task);
        const rebase = await this.deps.mergeCoordinator.runRebaseTask(task, attemptNumber, run.startedAt, workspace.worktree.path, baseBranch);
        if (!rebase.ok) {
          if (!rebase.conflict) throw new Error(`rebase onto ${baseBranch} failed: ${rebase.detail}`);
          rebaseConflict = true;
          record('lifecycle', { event: 'rebase-conflict', baseBranch });
        }
      }
      const steps = await this.deps.attempts.listSteps(turn.attemptAtStart.id);
      if (!steps.some((row) => row.type === 'implementation' && row.state === 'running')) {
        const implementation = await this.deps.attempts.createStep(turn.attemptAtStart.id, { type: 'implementation', logLocator: 'session:pending' });
        await this.deps.updateStep(task.id, implementation.id, { state: 'running', startedAt: Date.now() });
      }
      this.deps.gitBreaker?.recordSuccess(repoKey(task.workingDir));
      const mcpUrl = this.deps.mcpUrl();
      if (this.deps.keys && mcpUrl) {
        const runKey = await this.deps.keys.mint(run.id);
        workspace.env.HARMONIC_API_KEY = runKey;
        workspace.env.HARMONIC_MCP_URL = mcpUrl;
        mcpServers = adapterFor(task.harness).mcpServers({ url: mcpUrl, token: runKey });
      }
      if (this.deps.isShuttingDown()) return { kind: 'terminal' };
      child = this.deps.spawnHarness(task, harness, workspace.cwd, workspace.env, autoDriven);
      if (child.pid !== undefined) {
        await this.deps.attempts.update(run.id, { pid: child.pid, pgid: child.pid, procStartToken: readProcStartToken(child.pid) });
      }
      const stderr = child.stderr;
      if (stderr) {
        stderr.setEncoding('utf8');
        stderr.on('data', (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
        });
        stderrFlushed = new Promise<void>((resolve) => {
          stderr.on('end', resolve);
          stderr.on('error', () => resolve());
        });
      }
    } catch (err) {
      fireAndForget(() => this.deps.keys?.revoke(run.id), { op: 'runner.revokeKeyOnStartError', level: 'error', context: { attemptId: run.id, taskId: task.id } });
      if (err instanceof EpicBaseNotReady) {
        await this.deps.coordinateSettle(task, run, 'failed', {
          runState: 'failed',
          taskAction: 'ready',
          reason: err.reason,
        });
      } else if (err instanceof BaseBranchUnresolved) {
        await this.deps.settleEscalated(task, run, err.reason, {});
      } else if (err instanceof GitError) {
        const cls = classifyGitFailure([err.stderr, err.message].filter(Boolean).join('\n'));
        const failure = this.deps.gitBreaker?.recordFailure(repoKey(task.workingDir));
        if (cls === 'permanent' || failure?.opened) {
          await this.deps.settleEscalated(task, run, `git workspace preparation failed (${cls}): ${err.message}`, {});
        } else {
          await this.deps.coordinateSettle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: err.message });
        }
      } else {
        return { kind: 'actionable-fail', reason: err instanceof Error ? err.message : String(err), output: '' };
      }
      return { kind: 'terminal' };
    }

    const { active, driver, guardrails, listeners, finalize } = this.createTurnRuntime({
      task,
      run,
      harness,
      workspace,
      turn,
      autoDriven,
      attemptNumber,
      record,
      flushToolCalls,
      child,
    });

    try {
      if (await this.deps.pauseIfGloballyPaused(task.id)) {
        const pausedEvent = await this.deps.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'paused', reason: 'global pause' } });
        this.deps.events.onAttemptEvent?.(pausedEvent);
        await finalize();
        return { kind: 'terminal' };
      }
      const promptText = await this.initializeTurn({
        task,
        run,
        harness,
        workspace,
        mcpServers,
        turn,
        driver,
        listeners,
        guardrails,
        autoDriven,
        healCtx,
        rebaseConflict,
        record,
      });
      const driven = await this.drivePromptCycle({ task, driver, active, guardrails, listeners, autoDriven, promptText, record });
      escalating = driven.escalating;
      if (active.externallySettled) {
        await finalize();
        return { kind: 'terminal' };
      }

      if (active.pauseRequested) {
        if ((await this.deps.taskService.get(task.id)).state === 'working') await this.deps.taskService.pause(task.id);
        const usage = await this.deps.usage.collectUsageSafe({
          harnessId: task.harness,
          harness,
          cwd: workspace.cwd,
          attemptId: run.id,
          promptResult: driven.result,
        });
        if (usage?.contextTokens != null) this.deps.activeRuns.setLastTurnContextTokens(run.id, usage.contextTokens);
        this.noteModelMismatch(task, usage, record);
        await this.deps.attempts.update(run.id, { stopReason: driven.result.stopReason ?? null, usage: usage ? JSON.stringify(usage) : null });
        record('lifecycle', { event: 'finished', stopReason: driven.result.stopReason ?? null });
        if (!active.pauseFactRecorded) {
          const pausedEvent = await this.deps.attempts.appendEvent(run.id, {
            type: 'lifecycle',
            payload: { event: 'paused', reason: active.pauseReason ?? 'operator request' },
          });
          this.deps.events.onAttemptEvent?.(pausedEvent);
        }
        await finalize();
        if (active.globalPauseRequested) await this.deps.onGloballyPaused?.(task.id);
        return { kind: 'terminal' };
      }

      return await this.finishDrivenTurn({
        task,
        run,
        harness,
        parent,
        workspace,
        active,
        listeners,
        autoDriven,
        attemptNumber,
        driven,
        record,
        finalize,
        advanceTask,
      });
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      await Promise.race([stderrFlushed, new Promise((r) => setTimeout(r, 500))]);
      const tail = stderrTail.trim();
      const reason = tail ? `${base}\n\nharness stderr:\n${tail}` : base;
      await finalize();
      if (active.externallySettled) return { kind: 'terminal' };
      if (this.deps.isShuttingDown()) return { kind: 'terminal' };
      const usage = await this.deps.usage.collectUsageSafe({ harnessId: task.harness, harness, cwd: workspace.cwd, attemptId: run.id, promptResult: undefined });
      this.noteModelMismatch(task, usage, record);
      const patch = { usage: usage ? JSON.stringify(usage) : null };
      if (escalating) {
        record('lifecycle', { event: 'escalated', reason: escalating });
        await this.deps.settleEscalated(task, run, escalating, patch);
        return { kind: 'terminal' };
      }
      if ((await this.deps.attempts.get(run.id)).state !== 'running') {
        await this.deps.attempts.update(run.id, patch);
        return { kind: 'terminal' };
      }
      await this.deps.attempts.update(run.id, patch);
      return { kind: 'actionable-fail', reason, output: '' };
    } finally {
      guardrails.disarm();
      driver.fail(new Error('run finished'));
      driver.dispose();
      this.deps.activeRuns.delete(run.id);
      await finalize();
    }
  }

  private createTurnRuntime(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    workspace: Workspace;
    turn: TurnState;
    autoDriven: boolean;
    attemptNumber: number;
    record: RunEventRecorder;
    flushToolCalls: () => Promise<void>;
    child: ChildProcess;
  }): TurnRuntime {
    const {
      task,
      run,
      harness,
      workspace,
      turn,
      autoDriven,
      attemptNumber,
      record,
      flushToolCalls,
      child,
    } = input;
    const listeners = new TurnListeners({
      task,
      run,
      state: turn,
      autoDriven,
      events: this.deps.events,
      record,
      nextProgressSequence: () => this.deps.activeRuns.nextProgressSequence(run.id),
      outstandingAction: (event) => this.deps.activeRuns.setOutstandingProgressAction(run.id, event),
      completeOutstandingAction: (event) => {
        const outstanding = this.deps.activeRuns.getOutstandingProgressAction(run.id);
        if (outstanding && (event.ref === undefined || outstanding.ref === undefined || event.ref === outstanding.ref)) {
          this.deps.activeRuns.clearOutstandingProgressAction(run.id);
        }
      },
    });
    const driver = new AcpDriver(
      child,
      listeners,
      this.deps.getConfig().guardrails.promptInactivityTimeoutMinutes * 60_000,
    );
    const active: ActiveRun = {
      attemptId: run.id,
      taskId: task.id,
      child,
      driver,
      harnessId: task.harness,
      harness,
      cwd: workspace.cwd,
      activity: null,
      agentFinished: false,
      escalateReason: null,
      steerQueue: [],
      idle: false,
      externallySettled: false,
      steerable: false,
      pauseRequested: false,
      pauseReason: null,
      pauseFactRecorded: false,
      globalPauseRequested: false,
      verifyAbort: new AbortController(),
    };
    this.deps.activeRuns.set(run.id, active);
    turn.toolCallFlushTimer = setInterval(() => {
      fireAndForget(() => flushToolCalls(), { op: 'runner.flushToolCalls.interval', level: 'warn', context: { attemptId: run.id } });
    }, 10_000);
    turn.toolCallFlushTimer.unref?.();
    const guardrails = new GuardrailSupervisor(
      {
        attempts: this.deps.attempts,
        guardrailEvents: this.deps.guardrailEvents,
        getWorkspace: this.deps.getWorkspace,
        sampleSnapshot: (attemptId) => this.deps.usage.sampleSnapshot(attemptId),
        spendPollMs: this.deps.spendPollMs,
        spendGraceMs: this.deps.spendGraceMs,
      },
      {
        taskId: task.id,
        workspaceId: task.workspaceId,
        attemptId: run.id,
        attemptNumber,
        progressTrace: turn.progressEvents,
        attemptForTrip: () => this.deps.latestAttemptFor(task),
        outstandingAction: () => this.deps.activeRuns.getOutstandingProgressAction(run.id),
        record: (payload) => record('lifecycle', payload),
        settle: async (now, reason) => {
          active.externallySettled = true;
          await this.deps.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
        },
        abort: () => active.verifyAbort.abort(),
        kill: () => this.deps.kill(active),
        isSettled: () => active.externallySettled,
        isFinishing: () => active.agentFinished || active.escalateReason != null,
        hasPendingSteer: () => active.steerQueue.length > 0,
        pushSteer: (text) => active.steerQueue.push(text),
      },
    );
    active.guardrails = guardrails;
    listeners.setRuntime({ active, driver, guardrails });
    let finalized = false;
    const finalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      if (turn.sessionRowId !== undefined) {
        const sessionRowId = turn.sessionRowId;
        await bestEffort(() => this.deps.sessionStore.touch(sessionRowId, Date.now()), {
          op: 'runner.finalize.touchSession',
          level: 'warn',
          context: { attemptId: run.id, sessionRowId },
        });
      }
      await this.deps.tailer.stop(run.id);
      turn.clearTimer();
      await bestEffort(() => flushToolCalls(), { op: 'runner.finalize.flushToolCalls', level: 'warn', context: { attemptId: run.id } });
      this.deps.usage.dropReader(run.id);
      this.deps.kill(active);
      fireAndForget(() => this.deps.keys?.revoke(run.id), { op: 'runner.revokeKeyOnFinalize', level: 'error', context: { attemptId: run.id, taskId: task.id } });
      await bestEffort(() => this.deps.finalizeWorkspace(task, run, attemptNumber, workspace), {
        op: 'runner.finalize.finalizeWorkspace',
        level: 'error',
        context: { taskId: task.id, attemptId: run.id, attemptNumber },
      });
    };
    return { active, driver, guardrails, listeners, finalize };
  }

  private async initializeTurn(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    workspace: Workspace;
    mcpServers: unknown[];
    turn: TurnState;
    driver: AcpDriver;
    listeners: TurnListeners;
    guardrails: GuardrailSupervisor;
    autoDriven: boolean;
    healCtx: HealContext | undefined;
    rebaseConflict: boolean;
    record: RunEventRecorder;
  }): Promise<string> {
    const {
      task,
      run,
      harness,
      workspace,
      mcpServers,
      turn,
      driver,
      listeners,
      guardrails,
      autoDriven,
      healCtx,
      rebaseConflict,
      record,
    } = input;
    const modelId = adapterFor(task.harness).sessionModelId?.(task.model);
    const persistCtx: PersistSessionContext = {
      task,
      run,
      harness,
      workspace,
      mcpServers,
      attemptAtStart: turn.attemptAtStart,
      getSessionInit: () => turn.sessionInit,
      setSessionRowId: (id) => {
        turn.sessionRowId = id;
      },
    };
    const codeIndexRepoId = workspace.cwd !== task.workingDir ? await indexWorktree(workspace.cwd) : null;
    const continueSessionId =
      healCtx === undefined || healCtx.continuation.path === 'continued-session' ? run.sessionId : null;
    if (continueSessionId) {
      const outcome = await driver.load({
        sessionId: continueSessionId,
        cwd: workspace.cwd,
        mcpServers,
        modelId,
        onInitialize: listeners.onInitialize,
      });
      if (outcome.loaded) {
        record('lifecycle', { event: 'session-reloaded', sessionId: continueSessionId });
        await this.deps.sessionContinuation.persistSession(continueSessionId, persistCtx);
      } else {
        record('lifecycle', { event: 'session-reload-declined', reason: outcome.reason, detail: outcome.detail });
        await driver.handshake({
          cwd: workspace.cwd,
          mcpServers,
          modelId,
          onInitialize: listeners.onInitialize,
          onSessionCreated: (sid) => this.deps.sessionContinuation.persistSession(sid, persistCtx),
        });
      }
    } else {
      await driver.handshake({
        cwd: workspace.cwd,
        mcpServers,
        modelId,
        onInitialize: listeners.onInitialize,
        onSessionCreated: (sid) => this.deps.sessionContinuation.persistSession(sid, persistCtx),
      });
    }
    this.deps.tailer.start(run.id);
    await guardrails.prime();
    guardrails.armWallClock();
    guardrails.armToolTimeout();
    guardrails.armSpend();
    if (autoDriven) {
      const adapter = adapterFor(task.harness);
      const requested = harness.permissionMode;
      const advertised = [...driver.availableModes];
      const mode = adapter.unattendedPermissionMode(advertised, requested);
      const fallbackReason = requested !== undefined && requested !== mode
        ? 'configured-mode-not-advertised'
        : requested === undefined && adapter.defaultPermissionMode !== undefined && adapter.defaultPermissionMode !== mode
          ? 'default-mode-not-advertised'
          : undefined;
      logger.info('Unattended permission mode resolved', {
        taskId: task.id,
        attemptId: run.id,
        requested: requested ?? 'none',
        advertised: advertised.join(',') || 'none',
        chosen: mode ?? 'none',
        fallbackReason: fallbackReason ?? 'none',
      });
      const recordMode = (applied: string | null) =>
        record('lifecycle', {
          event: 'mode_set',
          mode: applied,
          requested: requested ?? null,
          advertised,
          applied,
          fallbackReason: fallbackReason ?? null,
        });
      if (!mode) {
        recordMode(null);
        if (adapter.requiresUnattendedPermissionMode) {
          throw new Error(
            `harness '${task.harness}' offers no unattended permission mode ` +
              `(available: ${driver.availableModes.join(', ') || 'none'})`,
          );
        }
      } else {
        await driver.setMode(mode);
        recordMode(mode);
        const sessionRowId = turn.sessionRowId;
        if (sessionRowId !== undefined) {
          await bestEffort(() => this.deps.sessionStore.setPermissionMode(sessionRowId, mode, Date.now()), {
            op: 'runner.setPermissionMode',
            level: 'warn',
            context: { taskId: task.id, sessionRowId, mode },
          });
        }
      }
    }
    let promptText = autoDriven
      ? await this.deps.autoDrive!.prompt(task)
      : promptForTask(
          { ...task, workingDir: workspace.cwd },
          resolveTaskPrompt(await this.deps.getWorkspace?.(task.workspaceId), this.deps.getConfig()),
        );
    const operatorSeed = this.deps.activeRuns.takePendingOperatorSeed(task.id);
    let condensed: string | null = null;
    if (operatorSeed !== undefined && !healCtx) {
      promptText = `## Operator message\n\n${operatorSeed}`;
    } else if (healCtx) {
      promptText = `${promptText}\n\n## Previous attempt failed — fix required (self-heal ${healCtx.attempt})\n` +
        `Your previous attempt did not pass:\n${healCtx.reason}\n\n${healCtx.output}\n\nFix the cause so the full verification suite passes, then finish.`;
      condensed = healCtx.condensedContext ?? null;
    } else if (task.continuationChoice === 'condensed') {
      const src = await this.deps.sessionContinuation.resolveContinuationSource(task);
      condensed = src ? await this.deps.sessionContinuation.condensedContext(src.prior) : null;
    }
    if (rebaseConflict) {
      promptText =
        `${promptText}\n\n## Rebase conflict — resolve first\n` +
        `Harmonic rebased your branch onto its base and the rebase stopped with conflicts left in progress in this checkout. ` +
        `Inspect the conflicted files (\`git status\`), resolve them, stage them, and run \`git rebase --continue\` before doing anything else.`;
    }
    if (condensed) promptText = `${promptText}\n\n${condensed}`;
    if (codeIndexRepoId) promptText = `${promptText}${codeIndexRepoGuidance(codeIndexRepoId)}`;
    await this.deps.attempts.update(run.id, { prompt: promptText });
    return promptText;
  }

  private async drivePromptCycle(input: {
    task: TaskRow;
    driver: AcpDriver;
    active: ActiveRun;
    guardrails: GuardrailSupervisor;
    listeners: TurnListeners;
    autoDriven: boolean;
    promptText: string;
    record: RunEventRecorder;
  }): Promise<{ result: PromptResult; connectionGone: boolean; escalating: string | null }> {
    const { task, driver, active, guardrails, listeners, autoDriven, record } = input;
    let promptText = input.promptText;
    let escalating: string | null = null;
    if (active.pauseRequested) return { result: {}, connectionGone: false, escalating: null };
    active.steerable = true;
    let connectionGone = false;
    const first = await this.promptTurn(driver, promptText, record);
    connectionGone ||= first.connectionGone;
    let result: PromptResult = first.result ?? {};
    active.idle = true;
    for (let attempt = 1; !escalating && !listeners.stoppedShort && !connectionGone; ) {
      if (active.externallySettled) break;
      if (active.pauseRequested && active.steerQueue.length === 0) break;
      if (active.escalateReason) {
        escalating = `the agent asked for a human: ${active.escalateReason}`;
        break;
      }
      if (await guardrails.checkProgressAtBoundary()) break;
      const steer = active.steerQueue.shift();
      if (steer !== undefined) {
        record('lifecycle', { event: 'steer_delivered', text: steer });
        active.idle = false;
        const turn = await this.promptTurn(driver, steer, record);
        connectionGone ||= turn.connectionGone;
        if (turn.result) result = turn.result;
        active.idle = true;
        if (connectionGone) break;
        continue;
      }
      if (!autoDriven || active.agentFinished || attempt > (await this.deps.autoDrive!.continueAttempts(task))) {
        break;
      }
      record('lifecycle', { event: 'continue', attempt });
      promptText = await this.deps.autoDrive!.continuePrompt(task);
      active.idle = false;
      const turn = await this.promptTurn(driver, promptText, record);
      connectionGone ||= turn.connectionGone;
      if (turn.result) result = turn.result;
      active.idle = true;
      if (connectionGone) break;
      attempt++;
    }
    active.idle = false;
    active.steerable = false;
    while (!connectionGone && !active.externallySettled && !escalating && !listeners.stoppedShort && active.steerQueue.length > 0) {
      const steer = active.steerQueue.shift()!;
      record('lifecycle', { event: 'steer_delivered', text: steer });
      const turn = await this.promptTurn(driver, steer, record);
      connectionGone ||= turn.connectionGone;
      if (turn.result) result = turn.result;
    }
    return { result, connectionGone, escalating };
  }

  private async finishDrivenTurn(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    parent: SpanContext;
    workspace: Workspace;
    active: ActiveRun;
    listeners: TurnListeners;
    autoDriven: boolean;
    attemptNumber: number;
    driven: { result: PromptResult; connectionGone: boolean; escalating: string | null };
    record: RunEventRecorder;
    finalize: () => Promise<void>;
    advanceTask: (to: 'verifying' | 'merging') => Promise<void>;
  }): Promise<TurnOutcome> {
    const {
      task,
      run,
      harness,
      parent,
      workspace,
      active,
      listeners,
      autoDriven,
      attemptNumber,
      record,
      finalize,
      advanceTask,
    } = input;
    let { result, connectionGone, escalating } = input.driven;
    record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
    const afkUnresolved = autoDriven && !escalating && !listeners.stoppedShort && !active.agentFinished;
    if (afkUnresolved) record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal; verifying anyway' });
    let implementationHead: string | null = null;
    let noChangeFinishHead: string | null = null;
    if (!escalating && !listeners.stoppedShort) {
      if (!connectionGone && !workspace.startDirty && (await Git.isDirty(workspace.cwd).catch(() => false))) {
        const nudge = 'Your implementation left uncommitted changes. Commit the completed work now, then finish.';
        record('lifecycle', { event: 'commit-nudge' });
        active.idle = false;
        const turn = await this.promptTurn(active.driver, nudge, record);
        connectionGone ||= turn.connectionGone;
        if (turn.result) result = turn.result;
        active.idle = true;
      }
      if (workspace.worktree && !workspace.startDirty && (await Git.isDirty(workspace.cwd).catch(() => false))) {
        await bestEffort(() => Git.commitAll(workspace.cwd, `harmonic: task ${task.id} attempt ${attemptNumber}`), {
          op: 'runner.finishDrivenTurn.commitAll',
          level: 'error',
          context: { taskId: task.id, attemptId: run.id, attemptNumber },
        });
      }
      const [head, base] = await Promise.all([
        Git.revParse(workspace.cwd, 'HEAD').catch(() => null),
        workspace.baseRev ? Git.revParse(workspace.cwd, workspace.baseRev).catch(() => null) : Promise.resolve(null),
      ]);
      if (head && head !== base) {
        implementationHead = head;
        await this.deps.attempts.update(run.id, { verifiedHeadOid: head });
      } else if (run.verifiedHeadOid) {
        implementationHead = run.verifiedHeadOid;
      } else if (active.agentFinished && head) {
        noChangeFinishHead = head;
      }
    }
    await finalize();
    const usage = await this.deps.usage.collectUsageSafe({
      harnessId: task.harness,
      harness,
      cwd: workspace.cwd,
      attemptId: run.id,
      promptResult: result,
    });
    if (usage?.contextTokens != null) this.deps.activeRuns.setLastTurnContextTokens(run.id, usage.contextTokens);
    this.noteModelMismatch(task, usage, record);
    const patch = {
      stopReason: result.stopReason ?? null,
      usage: usage ? JSON.stringify(usage) : null,
    };
    if (escalating) {
      record('lifecycle', { event: 'escalated', reason: escalating });
      await this.deps.settleEscalated(task, run, escalating, patch);
      return { kind: 'terminal' };
    }
    if (listeners.stoppedShort) {
      record('lifecycle', { event: 'stopped-short', reason: listeners.stoppedShort });
      return { kind: 'actionable-fail', reason: listeners.stoppedShort, output: '' };
    }
    await advanceTask('verifying');
    let noChange = false;
    if (noChangeFinishHead) {
      if (!(await this.deps.verification.criticEnabledFor(task))) {
        const reason = 'the agent finished without changing any files and no critic is configured to judge whether that is correct';
        record('lifecycle', { event: 'escalated', reason });
        await this.deps.settleEscalated(task, run, reason, patch);
        return { kind: 'terminal' };
      }
      implementationHead = noChangeFinishHead;
      noChange = true;
    }
    const { decision, ran: verifierRan } = await this.deps.verification.runVerification(
      task,
      run,
      implementationHead,
      active.verifyAbort.signal,
      record,
      parent,
    );
    if (this.deps.isShuttingDown()) return { kind: 'terminal' };
    if (active.externallySettled) {
      await finalize();
      return { kind: 'terminal' };
    }
    if (decision.outcome === 'block') {
      return await this.deps.verification.verificationFailTurn(task, decision, record);
    }
    if (decision.outcome !== 'proceed') {
      if ((await this.deps.attempts.get(run.id)).verifiedHeadOid == null) {
        const reason = `verification ${decision.outcome}: ${decision.reason}`;
        record('lifecycle', { event: 'escalated', reason });
        await this.deps.settleEscalated(task, run, reason, patch);
        return { kind: 'terminal' };
      }
      return await this.deps.verification.verificationFailTurn(task, decision, record);
    }
    if (afkUnresolved && (!verifierRan || (await this.deps.attempts.get(run.id)).verifiedHeadOid == null)) {
      record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal and no verifier vouched for the work' });
      return { kind: 'actionable-fail', reason: 'attempt ended without an execution-complete (finish_task) signal', output: '' };
    }
    const diff = await this.deps.diffSnapshotFor(task, run.id);
    const current = await this.deps.attempts.get(run.id);
    const worktreeMerge = task.isolationMode === 'worktree';
    const deps = this.deps.mergeCoordinator.mergePolicyDeps(task, run, record, active.verifyAbort.signal, patch);
    const mergeWorktreeBranch = async (): Promise<boolean> => {
      await this.deps.taskService.setMergeStatus(task.id, 'merging');
      const outcome = await runMergePolicy(
        {
          baseDir: task.workingDir,
          baseBranch: current.baseBranch!,
          taskBranch: current.branch!,
          conflictResolveTurns: task.conflictResolveTurns,
          postMergeCheck: this.deps.getConfig().merge.postMergeCheck,
        },
        deps,
      );
      if (outcome.kind === 'escalated') {
        record('lifecycle', { event: 'escalated', reason: outcome.message, gate: outcome.reason });
        if (outcome.reason === 'conflict') await this.deps.taskService.setMergeStatus(task.id, 'resolving-conflicts');
        return false;
      }
      record('lifecycle', { event: 'merged', oid: outcome.mergeOid, baseBranch: current.baseBranch });
      await this.deps.postMerge?.({ repoDir: task.workingDir, baseBranch: current.baseBranch! });
      return true;
    };
    if (!autoDriven) {
      if (!noChange && worktreeMerge && !(await mergeWorktreeBranch())) {
        return { kind: 'terminal' };
      }
      await advanceTask('merging');
      await this.deps.settleAutoCompleted(task, run, { ...patch, ...diff });
      return { kind: 'terminal' };
    }
    const mergeFate = await this.deps.autoDrive!.mergeFateFor(task);
    if (!noChange && worktreeMerge && mergeFate === 'auto-merge' && !(await mergeWorktreeBranch())) {
      return { kind: 'terminal' };
    }
    const outcome = noChange
      ? (await this.deps.autoDrive!.closeCompleted(task))
        ? 'completed'
        : 'escalate'
      : await this.deps.autoDrive!.onCompleted(task, await this.deps.attempts.get(run.id));
    if (outcome === 'escalate') {
      record('lifecycle', { event: 'escalated', reason: 'merge fate could not be applied' });
      await this.deps.settleEscalated(task, run, 'merge fate could not be applied', patch);
    } else {
      await advanceTask('merging');
      await this.deps.settleAutoCompleted(task, run, { ...patch, ...diff });
    }
    return { kind: 'terminal' };
  }

  private async promptTurn(
    driver: AcpDriver,
    text: string,
    record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
  ): Promise<{ result: PromptResult | null; connectionGone: boolean }> {
    try {
      return { result: await driver.prompt([{ type: 'text', text }]), connectionGone: false };
    } catch (err) {
      if (err instanceof AcpPromptTimeoutError) {
        record('lifecycle', { event: 'turn-timeout', reason: err.message });
        return { result: null, connectionGone: false };
      }
      if (err instanceof AcpConnectionClosedError) {
        record('lifecycle', { event: 'turn-eof', reason: err.message });
        return { result: null, connectionGone: true };
      }
      throw err;
    }
  }

  private noteModelMismatch(
    task: TaskRow,
    usage: AttemptUsage | null,
    record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
  ): void {
    const observed = usage ? observedModelMismatch(task.model, usage.models) : null;
    if (observed) record('lifecycle', { event: 'model_mismatch', expected: task.model, observed });
  }
}
