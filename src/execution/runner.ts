import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { GitError } from '../domain/errors.js';
import { attempted, bestEffort, fireAndForget, reportFailure } from '../error-handling.js';
import type { GitCircuitBreaker } from './git-failure.js';
import { adapterFor } from './harness/registry.js';
import { collectUsage, type AttemptUsage, type AttemptUsageSnapshot } from './usage.js';
import { LiveUsageTailer, type TailerCadence } from './live-usage-tailer.js';
import { UsageSampler } from './usage-sampler.js';
import { TranscriptCapture } from './transcript-capture.js';
import { ActiveRuns, type ActiveRun } from './active-runs.js';
import { dropIndexForPath } from './code-index.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET, type LiveAttemptEvent } from './live-events.js';
import { VerificationCoordinator, type EpicVerificationResolutionInput } from './verification-coordinator.js';
import { TurnDriver } from './turn-driver.js';
import { EpicRefreshResolver } from './epic-refresh-resolver.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import { isTaskAttempt, type TaskRow, type AttemptRow, type WorkspaceRow } from '../db/schema.js';
import { SessionStore } from '../domain/sessions.js';
import { type DeterministicContinuation } from '../domain/session-continuation.js';
import { DomainError } from '../domain/errors.js';
import { AttemptStore, type AttemptGuardrailSnapshot, type PersistedAttemptEvent } from '../domain/attempts.js';
import { AttemptSettleCoordinator, type SettleProjection, type DispositionKind } from '../domain/attempt-settle.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveGuardrails, resolvePauseMessage } from '../domain/setting-override.js';
import type { ResolvedGuardrails } from '../domain/setting-override.js';
import { SessionContinuation } from './session-continuation.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { MergeCoordinator, BaseBranchUnresolved, EpicBaseNotReady, type EpicIntegrationMergeInput } from './merge-coordinator.js';
export { BaseBranchUnresolved, EpicBaseNotReady };
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { type CriticHarnessDrive } from '../verification/critic.js';
import { pricesForHarness } from '../domain/pricing.js';
import { isForeignKeyViolation } from '../db/errors.js';
import { logger } from '../logger.js';
import type { PostMergeHook } from './branch-merge.js';
import type { MergePolicyOutcome } from './merge-policy.js';
import {
  parseIntegrationBranch,
} from './epic-coordinator.js';
import type { EpicRefreshResolveDispatchOutcome, EpicRefreshTarget } from './epic-coordinator.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { SpanContext } from '@opentelemetry/api';
import { startOperation } from '../telemetry/operations.js';

export type { LiveAttemptEvent } from './live-events.js';
export type { EpicVerificationResolutionInput } from './verification-coordinator.js';

const LIFECYCLE_SETTLE_GRACE_MS = 15_000;

export interface RunnerEvents {
  /** Fired after every run event is persisted (live streaming hook). */
  onAttemptEvent?: (event: PersistedAttemptEvent) => void;
  /** ACP session updates are transient: streamed to clients, never persisted. */
  onAttemptLogEvent?: (event: LiveAttemptEvent) => void;
  /** The critic turn's ACP session updates, on their own channel (same shape as
   * `onAttemptLogEvent`) so a running critic streams as its own chat. */
  onCriticLogEvent?: (event: LiveAttemptEvent) => void;
  /** Fired whenever a run reaches a terminal state. */
  onAttemptFinished?: (run: AttemptRow) => void;
  /** Fired ~1s while a run tails its native log. */
  onAttemptUsage?: (payload: { attemptId: number; snapshot: AttemptUsageSnapshot }) => void;
  /** Fired when a Step transitions within a still-running Attempt, so the
   * Task-detail timeline follows the live phase (the Attempt row is unchanged,
   * so `onAttemptFinished` never covers these). */
  onStepChanged?: (taskId: number) => void;
  /** Fired after each Epic integration-merge step is persisted, so the Epic's
   * merge progress can follow live (Epics have no Attempt row to stream). */
  onEpicMergeStep?: (payload: { workspaceId: number; epicRef: number }) => void;
}

export interface RunnerOptions {
  isGloballyPaused?: () => boolean;
  onGloballyPaused?: (taskId: number) => Promise<void>;
  events?: RunnerEvents;
  /** Where temporary worktrees live; per-run subdirectories. */
  worktreesDir?: string;
  /** Mints/revokes the per-Attempt scoped API key injected into the harness. */
  keys?: {
    mint: (attemptId: number) => Promise<string>;
    revoke: (attemptId: number) => void | Promise<void>;
  };
  /** Auto-drive collaborator for mirrored Tasks; absent on a native-only server. */
  autoDrive?: AutoDrive;
  /** Resolves a Task's ticket URL for the critic's `{url}` interpolation token;
   * absent → `{url}` resolves to empty. */
  urlFor?: (task: TaskRow) => string | null;
  /** Push/persist cadence for the live-usage tailer; defaults to ~1s/~10s. */
  tailerCadence?: TailerCadence;
  /** Spend-Guardrail poll + unmeasurable-grace cadence; defaults to ~1s poll / 60s grace. */
  spendGuardrail?: { pollMs?: number; graceMs?: number } | undefined;
  /** Resolves a Task's Workspace row for the Guardrail snapshot;
   * absent → the snapshot resolves against global defaults only. */
  getWorkspace?: (
    workspaceId: number | null,
  ) => Promise<
    | (Pick<
        WorkspaceRow,
        | 'guardrailBudget'
        | 'guardrailProgress'
        | 'toolTimeoutMinutes'
        | 'taskPreMergeCommands'
        | 'taskPreMergeCritics'
        | 'taskPostMergeCommands'
        | 'taskPostMergeCritics'
        | 'epicPreMergeCommands'
        | 'epicPreMergeCritics'
        | 'maxAttempts'
        | 'contextReuseTokenLimit'
        | 'taskPrompt'
        | 'pauseMessage'
      > &
        Partial<Pick<WorkspaceRow, 'workingDir'>>)
    | undefined
  >;
  /** Injectable agent-critic drive; absent → the real drive spawns the
   * builder's configured harness as a contained read-only reviewer. */
  criticDrive?: CriticHarnessDrive | undefined;
  /** Session retirement hook; absent → Sessions are never retired. */
  sessionRetirement?: SessionRetirementHook;
  /** Per-context git circuit breaker, shared with the Auto-Runner (which must
   * be given the SAME instance). Absent → no breaker. */
  gitBreaker?: GitCircuitBreaker;
  /** Start-funnel gate for parallel-Epic members: true while a Task's
   * integration base isn't ready to fork from. {@link Runner.beginRun} refuses
   * to spawn such an Attempt (a `DomainError`). Absent → not gated. */
  epicBaseNotReady?: (task: TaskRow) => boolean | Promise<boolean>;
  postMerge?: PostMergeHook;
}

export interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
  baseRev?: string;
  startDirty?: boolean;
}

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
      (task) => this.dispatchCwd(task),
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
    this.mergeCoordinator = new MergeCoordinator({
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
    });
    this.epicRefreshResolver = new EpicRefreshResolver({
      taskService: this.taskService,
      getConfig: this.getConfig,
      worktreesDir: this.worktreesDir,
      criticDrive: this.criticDrive,
    });
    this.verification = new VerificationCoordinator({
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
      worktreePathForTask: (task) => this.worktreePathForTask(task),
      latestAttemptFor: (task) => this.latestAttemptFor(task),
      updateStep: (taskId, id, patch) => this.updateStep(taskId, id, patch),
    });
    this.turnDriver = new TurnDriver({
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
      prepareWorkspace: (task, run, resume) => this.prepareWorkspace(task, run, resume),
      finalizeWorkspace: (task, run, attemptNumber, workspace) => this.finalizeWorkspace(task, run, attemptNumber, workspace),
      spawnHarness: (task, harness, cwd, extraEnv, unattended) => this.spawnHarness(task, harness, cwd, extraEnv, unattended),
      updateStep: (taskId, id, patch) => this.updateStep(taskId, id, patch),
      pauseIfGloballyPaused: (taskId) => this.pauseIfGloballyPaused(taskId),
      latestAttemptFor: (task) => this.latestAttemptFor(task),
      recordRunEvent: (task, run, type, payload) => this.recordRunEvent(task, run, type, payload),
      coordinateSettle: (task, run, type, projection, patch) => this.coordinateSettle(task, run, type, projection, patch),
      settleEscalated: (task, run, reason, patch) => this.settleEscalated(task, run, reason, patch),
      settleAutoCompleted: (task, run, patch) => this.settleAutoCompleted(task, run, patch),
      diffSnapshotFor: (task, attemptId) => this.diffSnapshotFor(task, attemptId),
      kill: (active) => this.kill(active),
    });
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
    await this.taskService.requeue(task.id, trimmed, choice);
    if (run) this.activeRuns.setPendingManualResume(task.id, run);
    if (startNow) {
      if (continuation) this.activeRuns.setPendingContinuation(task.id, continuation);
      await this.start(task.id);
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

  /**
   * Close: the ticket is cancelled; remove its branch and worktree and close
   * the tracker issue. Every step is a best-effort output side-effect.
   */
  async cleanupClosed(task: TaskRow, run: AttemptRow | undefined): Promise<void> {
    if (run) {
      try {
        await this.sessionRetirement?.onAttemptSettled(run, 'operator-cancel');
      } catch (err) {
        logger.error(`task ${task.id} close: session retirement failed: ${String(err)}`);
      }
      // git refuses to delete a branch a worktree still checks out.
      const session = run.sessionRowId === null ? null : await this.sessionStore.get(run.sessionRowId).catch(() => null);
      if (session?.worktreePath && session.worktreeRepoDir && existsSync(session.worktreePath)) {
        const removedPath = session.worktreePath;
        await Git.removeWorktree(session.worktreeRepoDir, removedPath)
          .then(() => dropIndexForPath(removedPath))
          .catch((err) => logger.error(`task ${task.id} close: worktree removal failed: ${String(err)}`));
      }
      if (run.branch && (await Git.branchCheckedOutAt(task.workingDir, run.branch).catch(() => null)) === null) {
        await Git.deleteBranch(task.workingDir, run.branch).catch((err) =>
          logger.error(`task ${task.id} close: branch '${run.branch}' removal failed: ${String(err)}`),
        );
      }
      this.events.onAttemptFinished?.(await this.attempts.get(run.id));
    }
    if (this.autoDrive && !(await this.autoDrive.closeTicket(task, `Closed by a Harmonic operator without merging (task ${task.id}).`))) {
      logger.error(`task ${task.id} close: tracker issue could not be closed`);
    }
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

  private worktreePathForTask(task: TaskRow): string {
    return join(this.worktreesDir, `task-${task.id}`);
  }

  private dispatchCwd(task: TaskRow): string {
    return task.isolationMode === 'worktree' ? this.worktreePathForTask(task) : task.workingDir;
  }

  private branchForTask(task: TaskRow): string {
    return `harmonic/task-${task.id}`;
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

  /**
   * Steer a task's active Attempt. When a turn is in flight and the harness
   * supports ACP `_session/steering`, the message is injected into the RUNNING
   * turn; otherwise it is queued and delivered as a fresh prompt turn at the
   * next turn boundary. Records a `steer_injected` or `steer_queued` lifecycle
   * event either way. Returns false (⇒ 409) when the task isn't running here or
   * its Attempt is no longer steerable.
   */
  async steer(taskId: number, text: string): Promise<boolean> {
    const active = this.activeRuns.forTask(taskId);
    if (!active || !active.steerable) return false;
    // ACP `promptRequired`: an idle session must not start an untracked turn.
    if (!active.idle && active.steerSupported !== false) {
      try {
        const res = await active.driver.steer([{ type: 'text', text }], { steering: { idleBehavior: 'promptRequired' } });
        if (res.outcome === 'injected') {
          active.steerSupported = true;
          const event = await this.attempts.appendEvent(active.attemptId, { type: 'lifecycle', payload: { event: 'steer_injected', text } });
          this.events.onAttemptEvent?.(event);
          this.emitSteerLog({ attemptId: active.attemptId, text, queued: false });
          return true;
        }
        // Outcome 'promptRequired': the turn ended before the RPC; nothing ran.
        active.steerSupported = true;
      } catch {
        // No `_session/steering` on this harness (codex/copilot, older claude-acp).
        active.steerSupported = false;
      }
    }
    if (!active.steerable) return false;
    active.steerQueue.push(text);
    const event = await this.attempts.appendEvent(active.attemptId, { type: 'lifecycle', payload: { event: 'steer_queued', text } });
    this.events.onAttemptEvent?.(event);
    this.emitSteerLog({ attemptId: active.attemptId, text, queued: true });
    return true;
  }

  /** Deliver the configured pause steer, then pause at the next prompt boundary. */
  async pause(taskId: number): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = this.activeRuns.forTask(taskId);
    if (!active || active.pauseRequested) return false;
    const message = resolvePauseMessage(await this.getWorkspace?.(task.workspaceId), this.getConfig());
    if (!(await this.steer(taskId, message))) return false;
    active.pauseRequested = true;
    active.pauseReason = 'operator request';
    logger.info('Task pause requested', { taskId, attemptId: active.attemptId, reason: active.pauseReason });
    return true;
  }

  async pauseForGlobal(taskId: number): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = this.activeRuns.forTask(taskId);
    if (!active) {
      await this.taskService.pause(taskId);
      await this.recordLifecycleTransition(taskId, 'paused', 'global pause');
      logger.info('Task paused', { taskId, reason: 'global pause' });
      return true;
    }
    if (!active.steerable) {
      active.pauseRequested = true;
      active.pauseReason = 'global pause';
      active.globalPauseRequested = true;
      await this.taskService.pause(taskId);
      await this.recordLifecycleTransition(taskId, 'paused', 'global pause');
      active.pauseFactRecorded = true;
      logger.info('Task paused', { taskId, attemptId: active.attemptId, reason: active.pauseReason });
      return true;
    }
    const paused = await this.pause(taskId);
    if (paused) {
      active.pauseReason = 'global pause';
      active.globalPauseRequested = true;
    }
    return paused;
  }

  /** Resume the still-running Attempt, restarting its wall-clock guardrail from
   * zero before reattaching its durable Session. */
  async resume(taskId: number, reason = 'operator request'): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'paused') return false;
    const startedAt = Date.now();
    const active = this.activeRuns.forTask(taskId);
    if (active) {
      active.pauseRequested = false;
      active.pauseReason = null;
      active.globalPauseRequested = false;
      await this.attempts.update(active.attemptId, { startedAt });
      active.guardrails?.resetWallClock(startedAt);
      await this.taskService.resume(taskId);
      await this.recordLifecycleTransition(taskId, 'resumed', reason);
      logger.info('Task resumed', { taskId, attemptId: active.attemptId, reason });
      return true;
    }
    const run = await this.attempts.getRunningForTask(taskId);
    if (!run) return false;
    await this.attempts.update(run.id, { startedAt });
    await this.taskService.resume(taskId);
    await this.recordLifecycleTransition(taskId, 'resumed', reason);
    logger.info('Task resumed', { taskId, attemptId: run.id, reason });
    try {
      await this.launchClaimed(taskId);
      return true;
    } catch (error) {
      await this.taskService.pause(taskId);
      throw error;
    }
  }

  /**
   * Extend the wall-clock guardrail of a working Task's live Attempt by
   * `addMinutes`. Persists the raised cap onto the Attempt's frozen
   * `guardrailConfig` (so a re-prime keeps it) and re-arms the live supervisor's
   * deadline in place. A no-op returning false when the Task is not working, has
   * no active Attempt, or carries no wall-clock budget to extend.
   */
  async extendGuardrail(taskId: number, addMinutes: number): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = this.activeRuns.forTask(taskId);
    if (!active) return false;
    const run = await this.attempts.get(active.attemptId);
    const config = run.guardrailConfig ? (JSON.parse(run.guardrailConfig) as ResolvedGuardrails) : null;
    if (!config?.budget) return false;
    const wallClockMinutes = config.budget.wallClockMinutes + addMinutes;
    const updated: ResolvedGuardrails = { ...config, budget: { ...config.budget, wallClockMinutes } };
    await this.attempts.update(active.attemptId, { guardrailConfig: JSON.stringify(updated) });
    active.guardrails?.extendWallClock(addMinutes);
    const event = await this.attempts.appendEvent(active.attemptId, {
      type: 'lifecycle',
      payload: { event: 'guardrail_extended', dimension: 'wall-clock', addMinutes, wallClockMinutes },
    });
    this.events.onAttemptEvent?.(event);
    logger.info('Wall-clock guardrail extended', { taskId, attemptId: active.attemptId, addMinutes, wallClockMinutes });
    return true;
  }

  private async pauseIfGloballyPaused(taskId: number): Promise<boolean> {
    if (!this.isGloballyPaused?.()) return false;
    if ((await this.taskService.get(taskId)).state === 'working') {
      await this.taskService.pause(taskId);
      await this.onGloballyPaused?.(taskId);
    }
    return true;
  }

  /**
   * Continue a settled Task's Session with an operator message. A cold Session
   * remains eligible: cache warmth changes the cost estimate, never whether the
   * operator can continue it. The settled Attempt is resumed in place.
   */
  async steerSettled(taskId: number, text: string): Promise<boolean> {
    if (this.activeRuns.hasTask(taskId)) return false;
    const task = await this.taskService.get(taskId);
    if (task.state !== 'escalated') return false;
    const src = await this.sessionContinuation.resolveContinuationSource(task);
    if (!src) return false;
    if (!this.sessionContinuation.resumeEligibilityFor(task, src.session).eligible) return false;
    this.activeRuns.setPendingOperatorSeed(taskId, text);
    try {
      await this.taskService.requeue(taskId, undefined, 'full');
      this.activeRuns.setPendingManualResume(taskId, src.prior);
      await this.start(taskId);
    } catch (err) {
      this.activeRuns.clearPendingOperatorSeed(taskId);
      throw err;
    }
    return true;
  }

  /**
   * Steer a paused Task: resume it to `working` and deliver the operator message.
   * A live paused Attempt is reattached (its wall-clock guardrail restarts) and
   * the message is steered into it; a torn-down one is continued from its
   * retained Session with the message as the seed of a fresh Attempt. Returns
   * false when the Task isn't paused or has no Session to continue.
   */
  async steerPaused(taskId: number, text: string): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'paused') return false;
    if (this.activeRuns.hasTask(taskId)) {
      return (await this.resume(taskId)) && (await this.steer(taskId, text));
    }
    const src = await this.sessionContinuation.resolveContinuationSource(task);
    if (!src || !this.sessionContinuation.resumeEligibilityFor(task, src.session).eligible) return false;
    this.activeRuns.setPendingOperatorSeed(taskId, text);
    try {
      await this.resumePaused(taskId);
    } catch (err) {
      this.activeRuns.clearPendingOperatorSeed(taskId);
      throw err;
    }
    return true;
  }

  /**
   * Resume a paused Task in its latest compatible Session when one is retained.
   * `continuation` is the operator's explicit pick: `condensed` starts a fresh
   * Session from a summary, `full`/undefined reuses the retained one. A Session
   * that is still live is always continued — a running process can't be forked
   * into a fresh attempt.
   */
  async resumePaused(taskId: number, continuation?: 'full' | 'condensed'): Promise<TaskRow> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'paused') return this.taskService.resume(taskId);
    if (this.activeRuns.hasTask(taskId)) return this.taskService.resume(taskId);
    const chosen = continuation ? await this.taskService.setContinuationChoice(taskId, continuation) : task;
    const src = await this.sessionContinuation.resolveContinuationSource(chosen);
    const resumed = await this.taskService.resume(taskId);
    if (!src || !this.sessionContinuation.resumeEligibilityFor(chosen, src.session).eligible) return resumed;
    try {
      await this.beginRun(resumed, undefined, src.prior);
    } catch (err) {
      await this.taskService.setState(taskId, 'paused');
      throw err;
    }
    return this.taskService.get(taskId);
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

  private spawnHarness(
    task: TaskRow,
    harness: HarnessConfig,
    cwd: string,
    extraEnv: Record<string, string>,
    unattended: boolean,
  ): ChildProcess {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...harness.env,
      HARMONIC_MODEL: task.model,
      ...adapterFor(task.harness).spawnEnv({ model: task.model, cwd, sessionLogDir: harness.sessionLogDir, unattended }),
      ...extraEnv,
    };
    return spawn(harness.command, harness.args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  }

  private async prepareWorkspace(task: TaskRow, run: AttemptRow, resume = false): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') {
      const workspace: Workspace = { cwd: task.workingDir, env: {} };
      const resolved = await attempted(
        async () => ({
          baseRev: await Git.revParse(task.workingDir, 'HEAD'),
          startDirty: resume ? false : await Git.isDirty(task.workingDir),
        }),
        {
          op: 'runner.prepareWorkspace.baseRev',
          level: 'warn',
          notFoundIf: (err) =>
            err instanceof GitError && /unknown revision|ambiguous argument 'HEAD'|does not have any commits yet/i.test(err.stderr),
          context: { taskId: task.id, attemptId: run.id, workingDir: task.workingDir, resume },
        },
      );
      if (resolved.ok) {
        workspace.baseRev = resolved.value.baseRev;
        workspace.startDirty = resolved.value.startDirty;
      }
      return workspace;
    }

    const path = this.worktreePathForTask(task);
    mkdirSync(this.worktreesDir, { recursive: true });

    if (existsSync(path) && !(await Git.isValidWorktree(task.workingDir, path))) {
      await Git.discardOrphanWorktree(task.workingDir, path);
    }

    if (resume) {
      const persisted = await this.attempts.get(run.id);
      const branch = persisted.branch ?? this.branchForTask(task);
      const baseBranch = persisted.baseBranch ?? (await this.mergeCoordinator.resolveBaseBranch(task));
      if (!existsSync(path)) {
        await Git.addWorktreeCheckout(task.workingDir, path, branch);
      }
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }

    const baseBranch = await this.mergeCoordinator.resolveBaseBranch(task);
    const branch = this.branchForTask(task);
    if (existsSync(path)) {
      await this.attempts.update(run.id, { branch, baseBranch });
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }
    if (await Git.branchExists(task.workingDir, branch)) {
      await Git.addWorktreeCheckout(task.workingDir, path, branch);
      await this.attempts.update(run.id, { branch, baseBranch });
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }
    if (parseIntegrationBranch(baseBranch) !== null && !(await Git.branchExists(task.workingDir, baseBranch))) {
      throw new EpicBaseNotReady(
        `Epic integration branch ${baseBranch} does not exist yet; it is cut/re-cut on the next tracker poll`,
      );
    }
    await Git.addWorktree(task.workingDir, path, branch, baseBranch);
    await this.attempts.update(run.id, { branch, baseBranch });
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
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

  private async finalizeWorkspace(task: TaskRow, run: AttemptRow, attemptNumber: number, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    const { repoDir, path } = workspace.worktree;
    await bestEffort(() => Git.commitAll(path, `harmonic: task ${task.id} attempt ${attemptNumber}`), {
      op: 'runner.finalizeWorkspace.commitAll',
      level: 'error',
      context: { taskId: task.id, attemptId: run.id, attemptNumber, path },
    });
    const sessionRowId = (await this.attempts.get(run.id)).sessionRowId;
    let retained = false;
    if (sessionRowId != null) {
      retained = await bestEffort(() => this.sessionStore.bindWorktree(sessionRowId, repoDir, path, Date.now()), {
        op: 'runner.finalizeWorkspace.bindWorktree',
        level: 'error',
        notFoundLevel: 'info',
        context: { taskId: task.id, attemptId: run.id, attemptNumber, sessionRowId, repoDir, worktreePath: path },
      });
    }
    if (!retained) {
      await bestEffort(() => Git.removeWorktree(repoDir, path), {
        op: 'runner.finalizeWorkspace.removeWorktree',
        level: 'debug',
        context: { taskId: task.id, attemptId: run.id, attemptNumber, repoDir, worktreePath: path },
      });
    }
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

  /**
   * Boot-time healing: finished runs whose stored usage has no per-model split
   * get one more read of the (now settled) session log. Stored ACP totals win
   * over re-derived ones.
   */
  async backfillUsage(): Promise<void> {
    const config = this.getConfig();
    for (const run of (await this.attempts.listUsageBackfillCandidates()).filter(isTaskAttempt)) {
      try {
        const task = await this.taskService.get(run.taskId);
        const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
        if (!harness) continue;
        // The worktree may be gone, but the harness's log path derives from the cwd string.
        const cwd = run.branch ? this.worktreePathForTask(task) : task.workingDir;
        const fresh = collectUsage({
          harnessId: task.harness,
          harness,
          cwd,
          sessionId: run.sessionId,
        });
        if (!fresh || Object.keys(fresh.models).length === 0) continue;
        fresh.toolCalls = Object.fromEntries(await this.usage.toolCallsFor(run.id));
        const stored = run.usage ? (JSON.parse(run.usage) as AttemptUsage) : null;
        const healed: AttemptUsage = stored?.totals
          ? { ...fresh, totals: stored.totals, source: 'combined' }
          : fresh;
        await this.attempts.update(run.id, { usage: JSON.stringify(healed) });
      } catch (err) {
        reportFailure(err, {
          op: 'runner.backfillUsage',
          level: 'warn',
          context: { attemptId: run.id, taskId: run.taskId, sessionId: run.sessionId ?? undefined },
        });
      }
    }
    await this.attempts.backfillCosts(async (attempt) => {
      if (!isTaskAttempt(attempt)) return pricesForHarness(config.harnesses.claude);
      const task = await this.taskService.get(attempt.taskId);
      return pricesForHarness(config.harnesses[task.harness as keyof typeof config.harnesses] ?? config.harnesses.claude);
    });
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
