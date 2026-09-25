import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { fireAndForget, reportFailure } from '../error-handling.js';
import type { GitCircuitBreaker } from './git-failure.js';
import type { AttemptUsageSnapshot } from './usage.js';
import { LiveUsageTailer } from './live-usage-tailer.js';
import { UsageSampler } from './usage-sampler.js';
import { TranscriptCapture } from './transcript-capture.js';
import { ActiveRuns, type ActiveRun } from './active-runs.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import { VerificationCoordinator, type EpicVerificationResolutionInput, type VerificationCoordinatorDeps } from './verification-coordinator.js';
import { TurnDriver, type TurnDriverDeps } from './turn-driver.js';
import { EpicRefreshResolver, type EpicRefreshResolverDeps } from './epic-refresh-resolver.js';
import { WorkspaceProvisioner, type WorkspaceProvisionerDeps } from './workspace-provisioner.js';
import { RunControl, type RunControlDeps } from './run-control.js';
import { UsageBackfiller, type UsageBackfillerDeps } from './usage-backfiller.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow, StepRow } from '../db/schema.js';
import { SessionStore } from '../domain/sessions.js';
import { type DeterministicContinuation } from '../domain/session-continuation.js';
import { DomainError } from '../domain/errors.js';
import { AttemptStore, type AttemptGuardrailSnapshot } from '../domain/attempts.js';
import { AttemptSettleCoordinator, type SettleProjection, type DispositionKind } from '../domain/attempt-settle.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveGuardrails } from '../domain/setting-override.js';
import { SessionContinuation } from './session-continuation.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { MergeCoordinator, BaseBranchUnresolved, EpicBaseNotReady, type EpicIntegrationMergeInput, type MergeCoordinatorDeps } from './merge-coordinator.js';
export { BaseBranchUnresolved, EpicBaseNotReady };
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { pricesForHarness } from '../domain/pricing.js';
import { isForeignKeyViolation } from '../db/errors.js';
import { logger } from '../logger.js';
import type { MergePolicyOutcome } from './merge-policy.js';
import type { EpicRefreshResolveDispatchOutcome, EpicRefreshTarget } from './epic-coordinator.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { SpanContext } from '@opentelemetry/api';
import { startOperation } from '../telemetry/operations.js';

export type { LiveAttemptEvent } from './live-events.js';
export type { EpicVerificationResolutionInput } from './verification-coordinator.js';
export type { RunnerEvents, RunnerOptions, Workspace } from './runner-options.js';
import type { RunnerEvents, RunnerOptions } from './runner-options.js';

const LIFECYCLE_SETTLE_GRACE_MS = 15_000;

export class Runner {
  private readonly activeRuns = new ActiveRuns();
  private readonly mergeCoordinator: MergeCoordinator;
  private shuttingDown = false;

  private readonly gitBreaker: GitCircuitBreaker | undefined;
  private readonly epicBaseNotReady: RunnerOptions['epicBaseNotReady'];
  private readonly events: RunnerEvents;
  private readonly worktreesDir: string;
  private readonly keys: RunnerOptions['keys'];
  private readonly autoDrive: AutoDrive | undefined;
  private readonly taskEvents: RunnerOptions['taskEvents'];
  private readonly getWorkspace: RunnerOptions['getWorkspace'];
  private readonly postMerge: RunnerOptions['postMerge'];
  private readonly criticDrive: RunnerOptions['criticDrive'];
  private readonly urlFor: (task: TaskRow) => string | null;
  private readonly verificationAttempts: VerificationAttemptStore;
  private readonly guardrailEvents: GuardrailEventStore;
  private readonly sessionStore: SessionStore;
  private readonly attempts: AttemptStore;
  private readonly settleCoordinator: AttemptSettleCoordinator;
  private readonly sessionRetirement: SessionRetirementHook | undefined;
  private readonly isGloballyPaused: (() => boolean) | undefined;
  private readonly onGloballyPaused: ((taskId: number) => Promise<void>) | undefined;
  private readonly tailer: LiveUsageTailer;
  private readonly usage: UsageSampler;
  private readonly transcripts: TranscriptCapture;
  private readonly sessionContinuation: SessionContinuation;
  private readonly spendPollMs: number;
  private readonly spendGraceMs: number;
  private readonly verification: VerificationCoordinator;
  private readonly turnDriver: TurnDriver;
  private readonly epicRefreshResolver: EpicRefreshResolver;
  private readonly workspaceProvisioner: WorkspaceProvisioner;
  private readonly runControl: RunControl;
  private readonly usageBackfiller: UsageBackfiller;
  /** The MCP endpoint agents should call back to; set once the server listens. */
  mcpUrl: string | null = null;

  constructor(
    private readonly taskService: TaskService,
    private readonly asyncDb: AsyncDbHandle,
    private readonly getConfig: () => AppConfig,
    options: RunnerOptions = {},
  ) {
    this.events = options.events ?? {};
    this.worktreesDir = options.worktreesDir ?? join(tmpdir(), 'harmonic-worktrees');
    this.keys = options.keys;
    this.autoDrive = options.autoDrive;
    this.taskEvents = options.taskEvents;
    this.getWorkspace = options.getWorkspace;
    this.postMerge = options.postMerge;
    this.gitBreaker = options.gitBreaker;
    this.epicBaseNotReady = options.epicBaseNotReady;
    this.criticDrive = options.criticDrive;
    this.urlFor = options.urlFor ?? (() => null);
    this.spendPollMs = options.spendGuardrail?.pollMs ?? 1000;
    this.spendGraceMs = options.spendGuardrail?.graceMs ?? 60_000;
    this.attempts = new AttemptStore(this.asyncDb);
    this.verificationAttempts = new VerificationAttemptStore(this.asyncDb);
    this.guardrailEvents = new GuardrailEventStore(this.asyncDb);
    this.sessionStore = new SessionStore(this.asyncDb);
    this.transcripts = new TranscriptCapture(this.sessionStore, this.verificationAttempts, this.getConfig);
    this.sessionContinuation = new SessionContinuation(
      this.attempts,
      this.sessionStore,
      this.transcripts,
      this.getConfig,
      { latestSnapshot: (attemptId) => this.usage.latestSnapshot(attemptId) },
      (attemptId) => this.activeRuns.getLastTurnContextTokens(attemptId),
      (task) => this.workspaceProvisioner.dispatchCwd(task),
    );
    this.usage = new UsageSampler(
      this.attempts,
      (attemptId) => {
        const a = this.activeRuns.get(attemptId);
        return a ? { harnessId: a.harnessId, harness: a.harness, cwd: a.cwd, activity: a.activity } : undefined;
      },
      this.activeRuns.toolCallTotalsView(),
    );
    this.settleCoordinator = new AttemptSettleCoordinator(
      this.taskService,
      this.attempts,
      (run) => this.events.onAttemptFinished?.(run),
      options.sessionRetirement,
    );
    this.sessionRetirement = options.sessionRetirement;
    this.isGloballyPaused = options.isGloballyPaused;
    this.onGloballyPaused = options.onGloballyPaused;
    this.tailer = new LiveUsageTailer(
      {
        sample: (attemptId) => this.usage.sampleSnapshot(attemptId),
        emit: (attemptId, snapshot) => this.events.onAttemptUsage?.({ attemptId, snapshot }),
        persist: (attemptId, snapshot) => {
          fireAndForget(() => this.attempts.update(attemptId, { liveUsage: JSON.stringify(snapshot) }), {
            op: 'runner.persistLiveUsage',
            level: 'warn',
            context: { attemptId },
          });
        },
      },
      options.tailerCadence,
    );
    this.mergeCoordinator = new MergeCoordinator(this.mergeCoordinatorDeps());
    this.epicRefreshResolver = new EpicRefreshResolver(this.epicRefreshResolverDeps());
    this.workspaceProvisioner = new WorkspaceProvisioner(this.workspaceProvisionerDeps());
    this.verification = new VerificationCoordinator(this.verificationCoordinatorDeps());
    this.turnDriver = new TurnDriver(this.turnDriverDeps());
    this.runControl = new RunControl(this.runControlDeps());
    this.usageBackfiller = new UsageBackfiller(this.usageBackfillerDeps());
  }

  private mergeCoordinatorDeps(): MergeCoordinatorDeps {
    return {
      getConfig: this.getConfig,
      attempts: this.attempts,
      verificationAttempts: this.verificationAttempts,
      epicMergeEvents: new EpicMergeEventStore(this.asyncDb),
      transcripts: this.transcripts,
      getWorkspace: this.getWorkspace,
      criticDrive: this.criticDrive,
      postMerge: this.postMerge,
      urlFor: this.urlFor,
      listWorkingTasks: () => this.taskService.list({ state: 'working' }),
      latestAttemptFor: (task) => this.latestAttemptFor(task),
      updateStep: (taskId, id, patch) => this.updateStep(taskId, id, patch),
      criticUpdateRelay: (attemptId) => this.criticUpdateRelay(attemptId),
      recordRunEvent: (task, run, type, payload) => this.recordRunEvent(task, run, type, payload),
      settleEscalated: (task, run, reason, patch) => this.settleEscalated(task, run, reason, patch),
      onEpicMergeStep: (payload) => this.events.onEpicMergeStep?.(payload),
    };
  }

  private epicRefreshResolverDeps(): EpicRefreshResolverDeps {
    return {
      taskService: this.taskService,
      getConfig: this.getConfig,
      worktreesDir: this.worktreesDir,
      criticDrive: this.criticDrive,
    };
  }

  private workspaceProvisionerDeps(): WorkspaceProvisionerDeps {
    return {
      attempts: this.attempts,
      sessionStore: this.sessionStore,
      mergeCoordinator: this.mergeCoordinator,
      autoDrive: this.autoDrive,
      sessionRetirement: this.sessionRetirement,
      events: this.events,
      worktreesDir: this.worktreesDir,
      taskEvents: this.taskEvents,
    };
  }

  private verificationCoordinatorDeps(): VerificationCoordinatorDeps {
    return {
      taskService: this.taskService,
      attempts: this.attempts,
      verificationAttempts: this.verificationAttempts,
      sessionStore: this.sessionStore,
      transcripts: this.transcripts,
      activeRuns: this.activeRuns,
      events: this.events,
      getConfig: this.getConfig,
      getWorkspace: this.getWorkspace,
      criticDrive: this.criticDrive,
      urlFor: this.urlFor,
      worktreePathForTask: (task) => this.workspaceProvisioner.worktreePathForTask(task),
      latestAttemptFor: (task) => this.latestAttemptFor(task),
      updateStep: (taskId, id, patch) => this.updateStep(taskId, id, patch),
    };
  }

  private turnDriverDeps(): TurnDriverDeps {
    return {
      taskService: this.taskService,
      attempts: this.attempts,
      sessionStore: this.sessionStore,
      guardrailEvents: this.guardrailEvents,
      usage: this.usage,
      tailer: this.tailer,
      getConfig: this.getConfig,
      activeRuns: this.activeRuns,
      mergeCoordinator: this.mergeCoordinator,
      verification: this.verification,
      sessionContinuation: this.sessionContinuation,
      events: this.events,
      autoDrive: this.autoDrive,
      keys: this.keys,
      getWorkspace: this.getWorkspace,
      postMerge: this.postMerge,
      gitBreaker: this.gitBreaker,
      onGloballyPaused: this.onGloballyPaused,
      spendPollMs: this.spendPollMs,
      spendGraceMs: this.spendGraceMs,
      mcpUrl: () => this.mcpUrl,
      isShuttingDown: () => this.shuttingDown,
      prepareWorkspace: (task, run, resume) => this.workspaceProvisioner.prepareWorkspace(task, run, resume),
      finalizeWorkspace: (task, run, attemptNumber, workspace) => this.workspaceProvisioner.finalizeWorkspace(task, run, attemptNumber, workspace),
      spawnHarness: (task, harness, cwd, extraEnv, unattended) => this.workspaceProvisioner.spawnHarness(task, harness, cwd, extraEnv, unattended),
      updateStep: (taskId, id, patch) => this.updateStep(taskId, id, patch),
      pauseIfGloballyPaused: (taskId) => this.pauseIfGloballyPaused(taskId),
      latestAttemptFor: (task) => this.latestAttemptFor(task),
      recordRunEvent: (task, run, type, payload) => this.recordRunEvent(task, run, type, payload),
      coordinateSettle: (task, run, type, projection, patch) => this.coordinateSettle(task, run, type, projection, patch),
      settleEscalated: (task, run, reason, patch) => this.settleEscalated(task, run, reason, patch),
      settleAutoCompleted: (task, run, patch) => this.settleAutoCompleted(task, run, patch),
      diffSnapshotFor: (task, attemptId) => this.diffSnapshotFor(task, attemptId),
      worktreePathForTask: (task) => this.workspaceProvisioner.worktreePathForTask(task),
      kill: (active) => this.kill(active),
    };
  }

  private runControlDeps(): RunControlDeps {
    return {
      taskService: this.taskService,
      attempts: this.attempts,
      activeRuns: this.activeRuns,
      events: this.events,
      getWorkspace: this.getWorkspace,
      getConfig: this.getConfig,
      isGloballyPaused: this.isGloballyPaused,
      onGloballyPaused: this.onGloballyPaused,
      sessionContinuation: this.sessionContinuation,
      emitSteerLog: (args) => this.emitSteerLog(args),
      recordLifecycleTransition: (taskId, event, reason) => this.recordLifecycleTransition(taskId, event, reason),
      start: (taskId) => this.start(taskId),
      launchClaimed: (taskId) => this.launchClaimed(taskId),
      beginRun: (task, parent, resumedAttempt) => this.beginRun(task, parent, resumedAttempt),
    };
  }

  private usageBackfillerDeps(): UsageBackfillerDeps {
    return {
      attempts: this.attempts,
      taskService: this.taskService,
      getConfig: this.getConfig,
      usage: this.usage,
      worktreePathForTask: (task) => this.workspaceProvisioner.worktreePathForTask(task),
    };
  }

  get activeCount(): number {
    return this.activeRuns.activeCount;
  }

  private emitSteerLog({ attemptId, text, queued }: { attemptId: number; text: string; queued: boolean }): void {
    const seq = this.activeRuns.nextProgressSequence(attemptId);
    this.events.onAttemptLogEvent?.({
      id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
      attemptId,
      seq,
      ts: Date.now(),
      type: 'session_update',
      payload: { sessionUpdate: 'operator_message', content: { type: 'text', text }, pending: true, queued },
    });
  }

  /**
   * Relay one critic turn's ACP session updates onto the critic-log channel,
   * verbatim and keyed by the builder Attempt — the same event shape the builder
   * streams, so the running critic renders through the identical chat viewer.
   */
  private criticUpdateRelay(attemptId: number): (update: { sessionUpdate: string; [key: string]: unknown }) => void {
    return (update) => {
      const seq = this.activeRuns.nextCriticLogSequence(attemptId);
      this.events.onCriticLogEvent?.({
        id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
        attemptId,
        seq,
        ts: Date.now(),
        type: 'session_update',
        payload: update,
      });
    };
  }

  private async latestAttemptFor(task: Pick<TaskRow, 'id'>): Promise<AttemptRow> {
    // The Task's LATEST Attempt, not just its `running` one: this is also
    // called from an operator Accept's merge (`mergePolicyDeps`), which runs
    // against an already-`escalated` Attempt — there is no `running` row to
    // find at that point, but the escalated one is still the relevant target
    // for verification/guardrail facts. Mirrors `AttemptStore.currentForTask`.
    const rows = await this.attempts.listForTask(task.id);
    const attempt = rows.at(-1);
    if (!attempt) throw new DomainError('not_found', `no attempt for task ${task.id} found`);
    return attempt;
  }

  /** Every active Attempt's ids plus its freshest live-usage snapshot. */
  async activeSnapshots(): Promise<{ attemptId: number; taskId: number; snapshot: AttemptUsageSnapshot | null }[]> {
    return Promise.all(
      [...this.activeRuns.values()].map(async (a) => ({
        attemptId: a.attemptId,
        taskId: a.taskId,
        snapshot: await this.usage.latestSnapshot(a.attemptId),
      })),
    );
  }

  /** Start a run for a ready task. Returns the created run immediately. */
  async start(taskId: number): Promise<AttemptRow> {
    const claimed = await this.taskService.claimReady(taskId);
    if (!claimed) {
      const task = await this.taskService.get(taskId);
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only ready tasks can run`);
    }
    try {
      const resumedAttempt = this.activeRuns.takePendingManualResume(taskId);
      return await this.beginRun(claimed, undefined, resumedAttempt);
    } catch (err) {
      await this.taskService.setState(taskId, 'ready');
      throw err;
    }
  }

  /** Resume an escalated ticket, optionally recording guidance for its next Attempt. */
  async resumeWithGuidance(task: TaskRow, guidance: string, startNow = false): Promise<void> {
    const trimmed = guidance.trim();
    if (!trimmed && !startNow) {
      await this.taskService.requeue(task.id);
      return;
    }
    const attempts = await this.attempts.listForTask(task.id);
    const run = attempts.at(-1);
    const escalated = attempts.findLast((attempt) => attempt.state === 'escalated');
    if (escalated && trimmed) await this.attempts.setFeedback(escalated.id, trimmed);
    let choice: 'full' | 'condensed' | undefined;
    let continuation: DeterministicContinuation | undefined;
    if (run) {
      continuation = await this.sessionContinuation.decideContinuation(task, run, await this.getWorkspace?.(task.workspaceId));
      choice = continuation.path === 'continued-session' ? 'full' : 'condensed';
    }
    // A reject always spawns a fresh Attempt (ADR-0038) — no setPendingManualResume
    // here, so beginRun takes its create() branch; the warm Session still binds
    // via bindContinuationIfEligible's Task-scoped lookup.
    await this.taskService.requeue(task.id, trimmed, choice);
    if (startNow) {
      if (continuation) this.activeRuns.setPendingContinuation(task.id, continuation);
      await this.start(task.id);
    }
  }

  /**
   * Operator Accept step-advance (ADR-0038): `failedStep` is already known
   * `failed` on `run`'s escalated Attempt. Marks it `passed` (the operator's
   * override) and resumes the pipeline at the next Step, on the same Attempt.
   * `rebase` re-drives a full implementation turn; `implementation` and
   * `verification` skip straight to the remaining verification stages with no
   * new turn, merging and settling `done` on pass or escalating again on fail.
   */
  async advanceAccepted(task: TaskRow, run: AttemptRow, failedStep: StepRow): Promise<void> {
    await this.attempts.updateStep(failedStep.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
    this.events.onStepChanged?.(task.id);
    const working = await this.taskService.setState(task.id, 'working');
    if (failedStep.type === 'rebase') {
      await this.beginRun(working, undefined, await this.attempts.get(run.id));
      return;
    }
    const running = await this.attempts.update(run.id, { state: 'running', endedAt: null, reason: null, detail: null });
    await this.driveAccept(working, running, failedStep.type === 'implementation' ? 'commands' : 'critics');
  }

  private async driveAccept(task: TaskRow, run: AttemptRow, startAt: 'commands' | 'critics'): Promise<void> {
    const operation = startOperation({ type: 'attempt', attributes: { 'task.id': task.id, 'attempt.id': run.id } });
    try {
      await operation.run(() =>
        this.turnDriver.driveAccept({
          task,
          run,
          record: (type, payload) => this.recordRunEvent(task, run, type, payload),
          parent: operation.spanContext,
          signal: new AbortController().signal,
          startAt,
        }),
      );
      operation.end();
    } catch (err) {
      operation.fail(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Escalate a ready ticket the scheduler could not spawn: claim it, record an
   * Attempt for the fact, and settle `escalate` through the coordinator. A
   * ticket that left `ready` meanwhile is left alone.
   */
  async escalateUnspawned(taskId: number, reason: string): Promise<void> {
    const task = await this.taskService.claimReady(taskId);
    if (!task) return;
    const run = await this.attempts.create(task.id);
    await this.settleEscalated(task, run, reason, {});
  }

  /** @see {@link WorkspaceProvisioner.cleanupClosed} */
  async cleanupClosed(task: TaskRow, run: AttemptRow | undefined): Promise<void> {
    return this.workspaceProvisioner.cleanupClosed(task, run);
  }

  /** Spawn a run for a task the caller already flipped to working (the mirrored pick). */
  async launchClaimed(taskId: number, parent?: SpanContext): Promise<AttemptRow> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'working') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; launchClaimed expects a task already flipped to working`);
    }
    const resumedAttempt = this.activeRuns.takePendingManualResume(taskId);
    return this.beginRun(task, parent, resumedAttempt);
  }

  private async beginRun(task: TaskRow, parent?: SpanContext, resumedAttempt?: AttemptRow): Promise<AttemptRow> {
    if (await this.epicBaseNotReady?.(task)) {
      throw new DomainError(
        'invalid_state',
        `task ${task.id} is an Epic member whose integration branch (${task.baseBranch ?? 'unassigned'}) is not ready yet; ` +
          'it is cut/re-cut on the next tracker poll — retry shortly',
      );
    }
    const config = this.getConfig();
    const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
    if (!harness) throw new DomainError('validation', `harness '${task.harness}' is not configured`);
    const ws = (await this.getWorkspace?.(task.workspaceId)) ?? { guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null };
    const snapshot: AttemptGuardrailSnapshot = {
      guardrailConfig: resolveGuardrails(ws, config),
      priceTable: pricesForHarness(harness),
    };
    const created = resumedAttempt
      ? await this.attempts.update(resumedAttempt.id, {
          state: 'running',
          startedAt: Date.now(),
          endedAt: null,
          reason: null,
          detail: null,
          guardrailConfig: JSON.stringify(snapshot.guardrailConfig),
          priceTable: JSON.stringify(snapshot.priceTable),
          ...(task.continuationChoice === 'condensed' ? { sessionRowId: null, sessionId: null } : {}),
        })
      : await this.attempts.create(task.id, snapshot);
    const pendingContinuation = this.activeRuns.takePendingContinuation(task.id);
    if (pendingContinuation !== undefined) {
      await this.attempts.setContinuation(created.id, pendingContinuation);
    }
    const run = created;
    const bound = await this.sessionContinuation.bindContinuationIfEligible(task, run);
    if (await this.pauseIfGloballyPaused(task.id)) return bound;
    const operation = startOperation({
      type: 'attempt',
      parent,
      attributes: {
        'task.id': task.id,
        'task.title': task.trackerTitle ?? task.prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? `Task ${task.id}`,
        'attempt.id': bound.id,
        'task.origin': task.origin,
        ...(task.workspaceId == null ? {} : { 'workspace.id': task.workspaceId }),
      },
    });
    this.activeRuns.setOperation(bound.id, operation);
    void operation.run(async () => {
      try {
        await this.turnDriver.drive(task, bound, harness, operation.spanContext);
        await this.finishRunOperation(bound.id);
      } catch (error) {
        operation.fail(error instanceof Error ? error.message : String(error));
        this.activeRuns.deleteOperation(bound.id);
      }
    });
    return bound;
  }

  operationParent(attemptId: number): SpanContext | undefined {
    return this.activeRuns.getOperation(attemptId)?.spanContext;
  }

  async finishRunOperation(attemptId: number): Promise<void> {
    const operation = this.activeRuns.getOperation(attemptId);
    if (!operation) return;
    const run = await this.attempts.get(attemptId);
    if (run.state === 'running') return;
    this.activeRuns.deleteOperation(attemptId);
    operation.update({
      'run.state': run.state,
      ...(run.reason ? { 'run.reason': run.reason } : {}),
    });
    if (run.state === 'failed') {
      operation.fail(run.reason ?? 'run failed');
    } else {
      operation.end();
    }
  }

  /** Kill the harness of a task's active run (task cancellation).
   * operator-cancel outranks every other disposition. */
  async cancelForTask(taskId: number): Promise<void> {
    // Callers invoke this fire-and-forget; an unhandled rejection would take the daemon down.
    try {
      await this.settleTaskRun(taskId, 'operator-cancel', { runState: 'cancelled', taskAction: 'none', reason: null });
    } catch (err) {
      logger.error(`cancelForTask(${taskId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stop a task's active run because an operator force-completed it (the task is
   * already `done`). Mirrors {@link cancelForTask} but settles the Attempt
   * `completed`.
   */
  async completeForTask(taskId: number): Promise<void> {
    await this.settleTaskRun(taskId, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'none', reason: null });
  }

  private async settleTaskRun(taskId: number, type: DispositionKind, projection: SettleProjection): Promise<void> {
    let handled = false;
    for (const active of this.activeRuns.values()) {
      if (active.taskId !== taskId) continue;
      handled = true;
      await this.settleRunIfPresent(taskId, active.attemptId, type, projection);
      this.kill(active);
    }
    if (handled) return;
    const parked = (await this.attempts.listForTask(taskId)).find((r) => r.state === 'running');
    if (parked) await this.settleRunIfPresent(taskId, parked.id, type, projection);
  }

  private async settleRunIfPresent(
    taskId: number,
    attemptId: number,
    type: DispositionKind,
    projection: SettleProjection,
  ): Promise<void> {
    try {
      await this.coordinateSettle(await this.taskService.get(taskId), await this.attempts.get(attemptId), type, projection);
    } catch (err) {
      if (isForeignKeyViolation(err) || (err instanceof DomainError && err.code === 'not_found')) return;
      throw err;
    }
  }

  /**
   * The agent-driven finish signal (`finish_task` MCP tool): mark this task's
   * active Attempt so the auto-drive continue loop stops re-prompting it. Returns
   * whether an active Attempt was found.
   */
  markAgentFinished(taskId: number): boolean {
    return this.forActiveTask(taskId, (active) => {
      active.agentFinished = true;
      active.driver.expectCompletion(LIFECYCLE_SETTLE_GRACE_MS);
    });
  }

  /**
   * The agent-driven escalation signal (`escalate_task` MCP tool): hands the
   * ticket to a human, superseding the retry budget. Returns whether an Attempt
   * matched.
   */
  markEscalate(taskId: number, reason: string): boolean {
    return this.forActiveTask(taskId, (active) => {
      active.escalateReason = reason;
      active.driver.expectCompletion(LIFECYCLE_SETTLE_GRACE_MS);
    });
  }

  /** @see {@link RunControl.steer} */
  async steer(taskId: number, text: string): Promise<boolean> {
    return this.runControl.steer(taskId, text);
  }

  /** @see {@link RunControl.pause} */
  async pause(taskId: number): Promise<boolean> {
    return this.runControl.pause(taskId);
  }

  /** @see {@link RunControl.pauseForGlobal} */
  async pauseForGlobal(taskId: number): Promise<boolean> {
    return this.runControl.pauseForGlobal(taskId);
  }

  /** @see {@link RunControl.resume} */
  async resume(taskId: number, reason = 'operator request'): Promise<boolean> {
    return this.runControl.resume(taskId, reason);
  }

  /** @see {@link RunControl.extendGuardrail} */
  async extendGuardrail(taskId: number, addMinutes: number): Promise<boolean> {
    return this.runControl.extendGuardrail(taskId, addMinutes);
  }

  private async pauseIfGloballyPaused(taskId: number): Promise<boolean> {
    return this.runControl.pauseIfGloballyPaused(taskId);
  }

  /** @see {@link RunControl.steerSettled} */
  async steerSettled(taskId: number, text: string): Promise<boolean> {
    return this.runControl.steerSettled(taskId, text);
  }

  /** @see {@link RunControl.steerPaused} */
  async steerPaused(taskId: number, text: string): Promise<boolean> {
    return this.runControl.steerPaused(taskId, text);
  }

  /** @see {@link RunControl.steerWorking} */
  async steerWorking(taskId: number, text: string): Promise<boolean> {
    return this.runControl.steerWorking(taskId, text);
  }

  /** @see {@link RunControl.resumePaused} */
  async resumePaused(taskId: number, continuation?: 'full' | 'condensed'): Promise<TaskRow> {
    return this.runControl.resumePaused(taskId, continuation);
  }

  private forActiveTask(taskId: number, fn: (active: ActiveRun) => void): boolean {
    const active = this.activeRuns.forTask(taskId);
    if (!active) return false;
    fn(active);
    return true;
  }

  /** Kill every active harness (process shutdown). */
  shutdown(): void {
    this.shuttingDown = true;
    for (const active of this.activeRuns.values()) {
      void this.tailer.stop(active.attemptId);
      active.verifyAbort.abort();
      this.kill(active);
    }
    this.activeRuns.clear();
    this.usage.clearReaders();
  }

  /** Patch a Step and announce the transition, so the Task-detail timeline
   * follows the live phase. Wraps every mid-Attempt Step mutation: each Step is
   * created then immediately set `running`, so patching alone covers every
   * open/settle transition without a second emit on creation. */
  private async updateStep(
    taskId: number,
    id: number,
    patch: Parameters<AttemptStore['updateStep']>[1],
  ): Promise<Awaited<ReturnType<AttemptStore['updateStep']>>> {
    const step = await this.attempts.updateStep(id, patch);
    this.events.onStepChanged?.(taskId);
    return step;
  }

  /** Run the corrective turn for a failed whole-Epic verification in a checked-out integration worktree. */
  async resolveEpicVerification(input: EpicVerificationResolutionInput): Promise<void> {
    return this.verification.resolveEpicVerification(input);
  }

  /** @see {@link EpicRefreshResolver.enqueueEpicRefreshResolution} */
  async enqueueEpicRefreshResolution(
    target: EpicRefreshTarget,
    detail: string,
    escalate: (epicRef: number, reason: string) => void | Promise<void>,
    retry: () => Promise<unknown>,
  ): Promise<EpicRefreshResolveDispatchOutcome> {
    return this.epicRefreshResolver.enqueueEpicRefreshResolution(target, detail, escalate, retry);
  }

  /** @see {@link MergeCoordinator.mergeEpicIntegration} */
  async mergeEpicIntegration(input: EpicIntegrationMergeInput): Promise<MergePolicyOutcome> {
    return this.mergeCoordinator.mergeEpicIntegration(input);
  }

  /** @see {@link MergeCoordinator.mergeAcceptedBranch} */
  async mergeAcceptedBranch(task: TaskRow, run: AttemptRow): Promise<MergePolicyOutcome> {
    return this.mergeCoordinator.mergeAcceptedBranch(task, run);
  }

  /** @see {@link MergeCoordinator.candidateHead} */
  async candidateHead(task: TaskRow, run: AttemptRow): Promise<string | null> {
    return this.mergeCoordinator.candidateHead(task, run);
  }

  private async recordLifecycleTransition(taskId: number, event: 'paused' | 'resumed', reason: string): Promise<void> {
    const run = await this.attempts.getRunningForTask(taskId);
    if (!run) return;
    const persisted = await this.attempts.appendEvent(run.id, { type: 'lifecycle', payload: { event, reason } });
    this.events.onAttemptEvent?.(persisted);
  }

  private recordRunEvent(
    task: TaskRow,
    run: AttemptRow,
    type: 'permission_request' | 'lifecycle',
    payload: unknown,
  ): void {
    (async () => {
      const event = await this.attempts.appendEvent(run.id, { type, payload });
      this.events.onAttemptEvent?.(event);
    })().catch((err: unknown) => {
      if (isForeignKeyViolation(err)) {
        logger.debug(`task ${task.id} attempt ${run.id}: dropped ${type} event — attempt row gone (racing delete)`);
        return;
      }
      logger.error(
        `task ${task.id} attempt ${run.id}: ${type} event append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Resolve a Session's native transcript path on demand and persist it. */
  async ensureSessionTranscript(sessionRowId: number): Promise<string | null> {
    return this.sessionContinuation.ensureSessionTranscript(sessionRowId);
  }

  /** @see {@link UsageBackfiller.backfillUsage} */
  async backfillUsage(): Promise<void> {
    return this.usageBackfiller.backfillUsage();
  }

  private async diffSnapshotFor(
    task: TaskRow,
    attemptId: number,
  ): Promise<Pick<AttemptRow, 'stat' | 'diffBaseOid' | 'diffHeadOid'>> {
    const run = await this.attempts.get(attemptId);
    if (!run.branch || !run.baseBranch) {
      return { stat: null, diffBaseOid: null, diffHeadOid: null };
    }
    try {
      const [diffBaseOid, diffHeadOid, stat] = await Promise.all([
        Git.mergeBase(task.workingDir, run.baseBranch, run.branch),
        Git.revParse(task.workingDir, run.branch),
        Git.diffStat(task.workingDir, run.baseBranch, run.branch),
      ]);
      return { stat, diffBaseOid, diffHeadOid };
    } catch (err) {
      logger.warn('diff snapshot failed; review diff will be blank for this attempt', {
        attemptId,
        branch: run.branch,
        baseBranch: run.baseBranch,
        err: err instanceof Error ? err.message : String(err),
      });
      return { stat: null, diffBaseOid: null, diffHeadOid: null };
    }
  }

  private async coordinateSettle(
    task: TaskRow,
    run: AttemptRow,
    type: DispositionKind,
    projection: SettleProjection,
    patch: Partial<AttemptRow> = {},
  ): Promise<void> {
    if (patch.stat === undefined && run.branch && run.baseBranch) {
      patch = { ...patch, ...(await this.diffSnapshotFor(task, run.id)) };
    }
    await this.settleCoordinator.settle(task, run, type, projection, patch);
    const timelineSteps = await this.attempts.listSteps(run.id);
    const now = Date.now();
    await Promise.all(timelineSteps.filter((timelineStep) => timelineStep.state === 'running').map((timelineStep) =>
      this.attempts.updateStep(timelineStep.id, {
        state: projection.runState === 'completed' ? 'passed' : 'failed',
        endedAt: now,
        verdict: projection.runState === 'completed' ? 'pass' : 'fail',
      }),
    ));
    await this.finishRunOperation(run.id);
  }

  private async settleAutoCompleted(task: TaskRow, run: AttemptRow, patch: Partial<AttemptRow>): Promise<void> {
    await this.coordinateSettle(
      task,
      run,
      'agent-finish/unresolved',
      { runState: 'completed', taskAction: 'done', reason: null },
      patch,
    );
  }

  private async settleEscalated(task: TaskRow, run: AttemptRow, reason: string, patch: Partial<AttemptRow>): Promise<void> {
    await this.coordinateSettle(task, run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: `escalated to human: ${reason}`,
    }, patch);
  }

  private kill(active: ActiveRun): void {
    try {
      if (active.child.exitCode === null && !active.child.killed) {
        const pid = active.child.pid;
        // Detached children may have spawned grandchildren; signal the whole group, not just the leader.
        if (pid !== undefined) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            active.child.kill('SIGKILL');
          }
        } else {
          active.child.kill('SIGKILL');
        }
      }
    } catch (err) {
      reportFailure(err, {
        op: 'runner.kill',
        level: 'warn',
        notFoundIf: (e) => (e as NodeJS.ErrnoException | null)?.code === 'ESRCH',
        context: { attemptId: active.attemptId },
      });
    }
  }
}
