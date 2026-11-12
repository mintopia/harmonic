import type { ChildProcess } from 'node:child_process';
import { GitError } from '../domain/errors.js';
import { bestEffort, type FireAndForget } from '../error-handling.js';
import { classifyGitFailure, type GitCircuitBreaker } from './git-failure.js';
import { adapterFor } from './harness/registry.js';
import type { LiveUsageTailer } from './live-usage-tailer.js';
import type { UsageSampler } from './usage-sampler.js';
import { GuardrailSupervisor } from './guardrail-supervisor.js';
import { ActiveRuns, type ActiveRun } from './active-runs.js';
import { indexWorktree } from './code-index.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { AcpDriver } from '../acp/driver.js';
import type { SessionStore } from '../domain/sessions.js';
import { repoKey } from './repo-lock.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SettleProjection, DispositionKind } from '../domain/attempt-settle.js';
import type { TaskService } from '../domain/tasks.js';
import type { EnginePrompts } from '../domain/bundled-prompts.js';
import { messageText, resolveAgentMessages } from '../domain/agent-messages.js';
import { SessionContinuation, type PersistSessionContext } from './session-continuation.js';
import { BaseBranchUnresolved, EpicBaseNotReady } from './merge-coordinator.js';
import type { RunBoundaryResult } from './run-control.js';
import type { GuardrailEventStore } from '../domain/guardrail-events.js';
import { logger } from '../logger.js';
import type { AgentMessageRow } from '../db/schema.js';
import { composeAttemptPrompt, composePeerContext } from './prompt-assembly.js';
import type { RunnerEvents, RunnerOptions, Workspace } from './runner.js';
import { TurnListeners, TurnState } from './turn-listeners.js';
import type { StepRunArchiveRef, TaskArchive } from '../archive/task-archive.js';
import { TurnCompletion, noteModelMismatch, type RunEventRecorder, type TurnCompletionDeps } from './turn-completion.js';
import type { PromptResult } from '../acp/driver.js';
import type { AgentDriveRequest, AgentDriveResult } from './workflow-engine.js';

const STDERR_TAIL_CAP = 8000;

const haltResult = (halt: 'paused' | 'settled'): AgentDriveResult => ({ output: '', permissionRequests: [], halt });

const emptyDrive = (turn: TurnState, sessionId: string): AgentDriveResult => ({
  output: turn.output,
  permissionRequests: [],
  sessionId: sessionId || null,
});

interface TurnRuntime {
  active: ActiveRun;
  driver: AcpDriver;
  guardrails: GuardrailSupervisor;
  listeners: TurnListeners;
  finalize: () => Promise<void>;
}

// codex-acp can exit non-zero mid-handshake with no ACP error; the cause is
// only on stderr. Draining the pipe also prevents backpressure.
interface StderrTail {
  tail: string;
  flushed: Promise<void>;
}

type SpawnTurnResult =
  | { ok: true; workspace: Workspace; mcpServers: unknown[]; child: ChildProcess; stderr: StderrTail }
  | { ok: false };

export interface TurnDriverDeps {
  taskService: TaskService;
  attempts: AttemptStore;
  sessionStore: SessionStore;
  guardrailEvents: GuardrailEventStore;
  fireAndForget: FireAndForget;
  usage: UsageSampler;
  tailer: LiveUsageTailer;
  getConfig: () => AppConfig;
  prompts: () => EnginePrompts;

  activeRuns: ActiveRuns;
  sessionContinuation: SessionContinuation;
  archive?: TaskArchive | undefined;

  events: RunnerEvents;
  autoDrive: AutoDrive | undefined;
  keys: RunnerOptions['keys'];
  getWorkspace: RunnerOptions['getWorkspace'];
  agentMessages: RunnerOptions['agentMessages'];
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
  checkRunBoundary: (taskId: number) => Promise<RunBoundaryResult>;
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
  kill: (active: ActiveRun) => void;
}

export class TurnDriver {
  private readonly completion: TurnCompletion;

  constructor(private readonly deps: TurnDriverDeps) {
    const completionDeps: TurnCompletionDeps = { attempts: deps.attempts };
    this.completion = new TurnCompletion(completionDeps);
  }

  async runAgentTurn(req: AgentDriveRequest): Promise<AgentDriveResult> {
    const { task, run } = req;
    if (!task || !run) throw new Error('runAgentTurn requires a task and run');
    const harness = req.harness;
    const record = (type: 'permission_request' | 'lifecycle', payload: unknown) => {
      this.deps.recordRunEvent(task, run, type, payload);
    };
    const boundary = await this.deps.checkRunBoundary(task.id);
    if (boundary.stop) {
      if (boundary.reason !== 'settled') record('lifecycle', { event: 'paused' });
      return haltResult(boundary.reason === 'settled' ? 'settled' : 'paused');
    }
    const attemptAtStart = await this.deps.attempts.ensureForRun(task.id, run.number, run.startedAt);
    const toolCalls = this.deps.activeRuns.getToolCallTotals(run.id) ?? (await this.deps.attempts.listToolCalls(attemptAtStart.id));
    this.deps.activeRuns.setToolCallTotals(run.id, toolCalls);
    const progressEvents = this.deps.activeRuns.getProgressTrace(run.id) ?? [];
    this.deps.activeRuns.setProgressTrace(run.id, progressEvents);
    const turn = new TurnState(attemptAtStart, toolCalls, progressEvents);
    const flushToolCalls = async () => {
      await this.deps.attempts.replaceToolCalls(turn.attemptAtStart.id, turn.toolCalls);
    };
    const autoDriven = this.deps.autoDrive?.handles(task) ?? false;
    const continueSessionId = req.continueSessionId ?? (task.continuationChoice !== 'condensed' ? run.sessionId : null);

    const spawned = await this.spawnTurn({ task, run, harness, resume: continueSessionId != null, turn, autoDriven, stepRun: req.stepRunId === undefined ? undefined : { pass: req.pass ?? null, stepId: req.stepId ?? '_', stepRunId: req.stepRunId } });
    if (!spawned.ok) return haltResult('settled');
    const { workspace, mcpServers, child, stderr } = spawned;

    const { active, driver, guardrails, listeners, finalize } = this.createTurnRuntime({
      task, run, harness, workspace, turn, autoDriven, attemptNumber: run.number, record, flushToolCalls, child,
    });

    try {
      const boundary = await this.deps.checkRunBoundary(task.id);
      if (boundary.stop) {
        if (boundary.reason !== 'settled') {
          const reason = boundary.reason === 'global-pause' ? 'global pause' : boundary.pauseReason;
          const pausedEvent = await this.deps.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event: 'paused', reason } });
          this.deps.events.onAttemptEvent?.(pausedEvent);
        }
        await finalize();
        return haltResult(boundary.reason === 'settled' ? 'settled' : 'paused');
      }
      const { promptText, operatorSeed, heldMessages } = await this.initializeTurn({
        task, run, harness, workspace, mcpServers, turn, driver, listeners, guardrails, autoDriven, continueSessionId, opening: req.prompt, record, stepRunId: req.stepRunId,
      });
      const messageStore = this.deps.agentMessages;
      const driven = await this.completion.drivePromptCycle({
        driver, active, guardrails, listeners, promptText, operatorSeed, record,
        onFirstPrompt: messageStore && heldMessages.length > 0 ? () => messageStore.markDelivered(heldMessages, task.id) : undefined,
      });
      if (active.externallySettled) {
        await finalize();
        return haltResult('settled');
      }

      if (active.pauseRequested) {
        // A pause before the first prompt consumed the seed from the pending map; put it back.
        if (operatorSeed !== undefined && !driven.operatorSeedDelivered) {
          this.deps.activeRuns.setPendingOperatorSeed(task.id, operatorSeed);
        }
        if ((await this.deps.taskService.get(task.id)).state === 'working') await this.deps.taskService.pause(task.id);
        await this.recordTurnUsage({ task, run, harness, workspace, result: driven.result, record });
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
        return haltResult('paused');
      }

      record('lifecycle', { event: 'finished', stopReason: driven.result.stopReason ?? null });
      if (!driven.escalating && !listeners.stoppedShort) {
        await this.completion.stampVerifiedHead({ run, workspace });
      }
      await finalize();
      await this.recordTurnUsage({ task, run, harness, workspace, result: driven.result, record });
      if (driven.escalating) {
        record('lifecycle', { event: 'escalated', reason: driven.escalating });
        return { ...emptyDrive(turn, driver.sessionId), escalate: driven.escalating };
      }
      if (listeners.stoppedShort) {
        record('lifecycle', { event: 'stopped-short', reason: listeners.stoppedShort });
        throw new Error(listeners.stoppedShort);
      }
      return emptyDrive(turn, driver.sessionId);
    } catch (err) {
      await finalize();
      if (active.externallySettled || this.deps.isShuttingDown()) return haltResult('settled');
      const base = err instanceof Error ? err.message : String(err);
      await Promise.race([stderr.flushed, new Promise((r) => setTimeout(r, 500))]);
      const tail = stderr.tail.trim();
      throw new Error(tail ? `${base}\n\nharness stderr:\n${tail}` : base);
    } finally {
      guardrails.disarm();
      driver.fail(new Error('run finished'));
      driver.dispose();
      this.deps.activeRuns.delete(run.id);
      await finalize();
    }
  }

  private async recordTurnUsage(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    workspace: Workspace;
    result: PromptResult | undefined;
    record: RunEventRecorder;
  }): Promise<void> {
    const { task, run, harness, workspace, result, record } = input;
    const usage = await this.deps.usage.collectUsageSafe({ harnessId: task.harness, harness, cwd: workspace.cwd, attemptId: run.id, promptResult: result });
    if (usage?.contextTokens != null) this.deps.activeRuns.setLastTurnContextTokens(run.id, usage.contextTokens);
    noteModelMismatch(task, usage, record);
    await this.deps.attempts.update(run.id, { stopReason: result?.stopReason ?? null, usage: usage ? JSON.stringify(usage) : null });
  }

  /** Prepares the workspace and spawns the harness; a handled failure settles the run and reports `ok: false`. */
  private async spawnTurn(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    resume: boolean;
    turn: TurnState;
    autoDriven: boolean;
    stepRun: StepRunArchiveRef | undefined;
  }): Promise<SpawnTurnResult> {
    const { task, run, harness, resume, turn, autoDriven, stepRun } = input;
    const stderr: StderrTail = { tail: '', flushed: Promise.resolve() };
    try {
      const workspace = await this.deps.prepareWorkspace(task, run, resume);
      turn.archive = stepRun ? this.deps.archive?.stepRun(task, run.number, stepRun) : undefined;
      this.deps.gitBreaker?.recordSuccess(repoKey(task.workingDir));
      let mcpServers: unknown[] = [];
      const mcpUrl = this.deps.mcpUrl();
      if (this.deps.keys && mcpUrl) {
        const runKey = await this.deps.keys.mint(run.id);
        workspace.env.HARMONIC_API_KEY = runKey;
        workspace.env.HARMONIC_MCP_URL = mcpUrl;
        mcpServers = adapterFor(task.harness).mcpServers({ url: mcpUrl, token: runKey });
      }
      if (this.deps.isShuttingDown()) return { ok: false };
      const child = this.deps.spawnHarness(task, harness, workspace.cwd, workspace.env, autoDriven);
      const childStderr = child.stderr;
      if (childStderr) {
        childStderr.setEncoding('utf8');
        childStderr.on('data', (chunk: string) => {
          stderr.tail = (stderr.tail + chunk).slice(-STDERR_TAIL_CAP);
        });
        stderr.flushed = new Promise<void>((resolve) => {
          childStderr.on('end', resolve);
          childStderr.on('error', () => resolve());
        });
      }
      return { ok: true, workspace, mcpServers, child, stderr };
    } catch (err) {
      this.deps.fireAndForget(() => this.deps.keys?.revoke(run.id), { op: 'runner.revokeKeyOnStartError', level: 'error', context: { attemptId: run.id, taskId: task.id } });
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
        throw err;
      }
      return { ok: false };
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
      this.deps.fireAndForget(() => flushToolCalls(), { op: 'runner.flushToolCalls.interval', level: 'warn', context: { attemptId: run.id } });
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
        fireAndForget: this.deps.fireAndForget,
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
        pushSteer: (text) => active.steerQueue.push({ text }),
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
      for (const entry of active.steerQueue.splice(0)) entry.onDropped?.();
      this.deps.kill(active);
      this.deps.fireAndForget(() => this.deps.keys?.revoke(run.id), { op: 'runner.revokeKeyOnFinalize', level: 'error', context: { attemptId: run.id, taskId: task.id } });
      await bestEffort(() => this.deps.finalizeWorkspace(task, run, attemptNumber, workspace), {
        op: 'runner.finalize.finalizeWorkspace',
        level: 'error',
        context: { taskId: task.id, attemptId: run.id, attemptNumber },
      });
      const archive = turn.archive;
      if (archive) {
        await bestEffort(async () => {
          const path = turn.sessionRowId !== undefined ? await this.deps.sessionContinuation.ensureSessionTranscript(turn.sessionRowId) : null;
          await archive.copyNative(task.harness, path);
        }, { op: 'runner.finalize.archiveNative', level: 'warn', context: { attemptId: run.id } });
        await bestEffort(() => archive.close(), { op: 'runner.finalize.archiveClose', level: 'warn', context: { attemptId: run.id } });
      }
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
    continueSessionId: string | null;
    opening: string;
    record: RunEventRecorder;
    stepRunId: number | undefined;
  }): Promise<{ promptText: string; operatorSeed: string | undefined; heldMessages: AgentMessageRow[] }> {
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
      continueSessionId,
      opening,
      record,
    } = input;
    const modelId = adapterFor(task.harness).sessionModelId?.(task.model);
    const persistCtx: PersistSessionContext = {
      task,
      run,
      harness,
      workspace,
      mcpServers,
      stepRunId: input.stepRunId,
      getSessionInit: () => turn.sessionInit,
      setSessionRowId: (id) => {
        turn.sessionRowId = id;
      },
    };
    const codeIndexRepoId = workspace.cwd !== task.workingDir ? await indexWorktree(workspace.cwd) : null;
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
    const prompts = this.deps.prompts();
    const operatorSeed = this.deps.activeRuns.takePendingOperatorSeed(task.id);
    const peer = await this.peerContext(task, prompts);
    const promptText = composeAttemptPrompt(
      {
        opening,
        seed: operatorSeed,
        seedMode: 'append',
        heal: undefined,
        freshSessionContext: null,
        condensed: null,
        peerText: peer.text,
        rebaseConflict: false,
        codeIndexRepoId,
      },
      prompts,
    );
    return { promptText, operatorSeed, heldMessages: peer.held };
  }

  /** Held peer messages from the database (left held until the prompt is sent), plus the peer line, when Agent Messages are on. */
  private async peerContext(task: TaskRow, prompts: EnginePrompts): Promise<{ text: string; held: AgentMessageRow[] }> {
    const store = this.deps.agentMessages;
    if (!store) return { text: '', held: [] };
    const workspace = await this.deps.getWorkspace?.(task.workspaceId);
    const { enabled } = resolveAgentMessages(workspace, this.deps.getConfig().agentMessages);
    if (!enabled) return { text: '', held: [] };
    const held = await store.listHeld(task.id);
    const harnesses = new Map<number, string>();
    for (const id of new Set(held.map((m) => m.senderTaskId))) {
      const sender = await this.deps.taskService.get(id).catch(() => null);
      if (sender) harnesses.set(id, sender.harness);
    }
    const entries = held.map((m) => ({ taskId: m.senderTaskId, harness: harnesses.get(m.senderTaskId) ?? 'agent', text: messageText(m) }));
    return { text: composePeerContext(entries, prompts), held };
  }

}
