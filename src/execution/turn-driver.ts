import type { ChildProcess } from 'node:child_process';
import { GitError } from '../domain/errors.js';
import { bestEffort, fireAndForget } from '../error-handling.js';
import { classifyGitFailure, type GitCircuitBreaker } from './git-failure.js';
import { adapterFor } from './harness/registry.js';
import { readProcStartToken } from './process-reaper.js';
import type { LiveUsageTailer } from './live-usage-tailer.js';
import type { UsageSampler } from './usage-sampler.js';
import { GuardrailSupervisor } from './guardrail-supervisor.js';
import { ActiveRuns, type ActiveRun } from './active-runs.js';
import { codeIndexRepoGuidance, promptForTask } from './prompt-template.js';
import { indexWorktree } from './code-index.js';
import type { VerificationCoordinator } from './verification-coordinator.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { AcpDriver } from '../acp/driver.js';
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
import { logger } from '../logger.js';
import type { SpanContext } from '@opentelemetry/api';
import type { RunnerEvents, RunnerOptions, Workspace } from './runner.js';
import { TurnListeners, TurnState } from './turn-listeners.js';
import { TurnCompletion, noteModelMismatch, type TurnOutcome, type RunEventRecorder, type TurnCompletionDeps } from './turn-completion.js';

const STDERR_TAIL_CAP = 8000;

interface HealContext {
  reason: string;
  output: string;
  attempt: number;
  continuation: DeterministicContinuation;
  condensedContext: string | null;
}

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
  | { ok: true; workspace: Workspace; mcpServers: unknown[]; child: ChildProcess; stderr: StderrTail; rebaseConflict: boolean }
  | { ok: false; outcome: TurnOutcome };

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
  private readonly completion: TurnCompletion;

  constructor(private readonly deps: TurnDriverDeps) {
    const completionDeps: TurnCompletionDeps = {
      attempts: deps.attempts,
      usage: deps.usage,
      activeRuns: deps.activeRuns,
      mergeCoordinator: deps.mergeCoordinator,
      verification: deps.verification,
      autoDrive: deps.autoDrive,
      taskService: deps.taskService,
      getConfig: deps.getConfig,
      postMerge: deps.postMerge,
      isShuttingDown: deps.isShuttingDown,
      settleEscalated: deps.settleEscalated,
      settleAutoCompleted: deps.settleAutoCompleted,
      diffSnapshotFor: deps.diffSnapshotFor,
    };
    this.completion = new TurnCompletion(completionDeps);
  }

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

    const spawned = await this.spawnTurn({ task, run, harness, healCtx, attemptNumber, opensAttempt, turn, autoDriven, record });
    if (!spawned.ok) return spawned.outcome;
    const { workspace, mcpServers, child, stderr, rebaseConflict } = spawned;

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
      const driven = await this.completion.drivePromptCycle({ task, driver, active, guardrails, listeners, autoDriven, promptText, record });
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
        noteModelMismatch(task, usage, record);
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

      return await this.completion.finishDrivenTurn({
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
      await Promise.race([stderr.flushed, new Promise((r) => setTimeout(r, 500))]);
      const tail = stderr.tail.trim();
      const reason = tail ? `${base}\n\nharness stderr:\n${tail}` : base;
      await finalize();
      if (active.externallySettled) return { kind: 'terminal' };
      if (this.deps.isShuttingDown()) return { kind: 'terminal' };
      const usage = await this.deps.usage.collectUsageSafe({ harnessId: task.harness, harness, cwd: workspace.cwd, attemptId: run.id, promptResult: undefined });
      noteModelMismatch(task, usage, record);
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

  /** Prepare the workspace, rebase if needed, and spawn the harness process. On
   * failure, settles the run appropriately and returns the outcome to bubble up. */
  private async spawnTurn(input: {
    task: TaskRow;
    run: AttemptRow;
    harness: HarnessConfig;
    healCtx: HealContext | undefined;
    attemptNumber: number;
    opensAttempt: boolean;
    turn: TurnState;
    autoDriven: boolean;
    record: RunEventRecorder;
  }): Promise<SpawnTurnResult> {
    const { task, run, harness, healCtx, attemptNumber, opensAttempt, turn, autoDriven, record } = input;
    const stderr: StderrTail = { tail: '', flushed: Promise.resolve() };
    let rebaseConflict = false;
    try {
      const workspace = await this.deps.prepareWorkspace(task, run, healCtx !== undefined);
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
      let mcpServers: unknown[] = [];
      const mcpUrl = this.deps.mcpUrl();
      if (this.deps.keys && mcpUrl) {
        const runKey = await this.deps.keys.mint(run.id);
        workspace.env.HARMONIC_API_KEY = runKey;
        workspace.env.HARMONIC_MCP_URL = mcpUrl;
        mcpServers = adapterFor(task.harness).mcpServers({ url: mcpUrl, token: runKey });
      }
      if (this.deps.isShuttingDown()) return { ok: false, outcome: { kind: 'terminal' } };
      const child = this.deps.spawnHarness(task, harness, workspace.cwd, workspace.env, autoDriven);
      if (child.pid !== undefined) {
        await this.deps.attempts.update(run.id, { pid: child.pid, pgid: child.pid, procStartToken: readProcStartToken(child.pid) });
      }
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
      return { ok: true, workspace, mcpServers, child, stderr, rebaseConflict };
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
        return { ok: false, outcome: { kind: 'actionable-fail', reason: err instanceof Error ? err.message : String(err), output: '' } };
      }
      return { ok: false, outcome: { kind: 'terminal' } };
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

}
