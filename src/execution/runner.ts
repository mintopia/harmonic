import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { GitError } from '../domain/errors.js';
import { classifyGitFailure, type GitCircuitBreaker } from './git-failure.js';
import { adapterFor, adapterVersion } from './harness/registry.js';
import { readProcStartToken } from './process-reaper.js';
import { collectUsage, observedModelMismatch, activityLine, toolCallName, type AttemptUsage, type AttemptUsageSnapshot } from './usage.js';
import { LiveUsageTailer, type TailerCadence } from './live-usage-tailer.js';
import { UsageSampler } from './usage-sampler.js';
import { TranscriptCapture } from './transcript-capture.js';
import { GuardrailSupervisor } from './guardrail-supervisor.js';
import { codeIndexRepoGuidance, driveFields, promptForTask } from './prompt-template.js';
import { indexWorktree, dropIndexForPath } from './code-index.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, AttemptRow, WorkspaceRow, SessionRow } from '../db/schema.js';
import { AcpDriver, AcpPromptTimeoutError, type AcpInitializeResult, type PromptResult } from '../acp/driver.js';
import { AcpConnectionClosedError } from '../acp/connection.js';
import { parsePermissionRequest } from '../acp/permission-request.js';
import { SessionStore } from '../domain/sessions.js';
import { assessResumeEligibility, sessionFacts, type ResumeEnvironment } from '../domain/session-resume.js';
import {
  planSessionContinuation,
  sessionWarmthFacts,
  decideAttemptContinuation,
  type ContinuationTrigger,
  type DeterministicContinuation,
} from '../domain/session-continuation.js';
import { repoKey } from './repo-lock.js';
import { DomainError } from '../domain/errors.js';
import { AttemptStore, type AttemptGuardrailSnapshot, type PersistedAttemptEvent } from '../domain/attempts.js';
import { AttemptSettleCoordinator, type SettleProjection, type DispositionKind } from '../domain/attempt-settle.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveGuardrails, resolvePauseMessage, resolveVerifiers, resolveScoped, resolveTaskPrompt } from '../domain/setting-override.js';

function configuredCacheWarmSeconds(config: AppConfig, harness: string): number | undefined {
  return Object.entries(config.harnesses).find(([id]) => id === harness)?.[1].cacheWarmSeconds;
}
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { toProgressEvents } from '../domain/guardrail-progress.js';
import type { ProgressEvent } from '../domain/stall-detector.js';
import { runCommandVerifier, commandAttemptToInput } from '../verification/command-verifier.js';
import { createAcpCriticDrive, runCritic, criticAttemptToInput, type CriticHarnessDrive } from '../verification/critic.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import { pricesForHarness } from '../domain/pricing.js';
import { isForeignKeyViolation } from '../db/errors.js';
import { logger } from '../logger.js';
import type { PostMergeHook } from './branch-merge.js';
import { runMergePolicy, type MergePolicyDeps, type MergePolicyOutcome, type MergeStepEvent, type PostMergeCheckResult } from './merge-policy.js';
import {
  integrationBranchName,
  parseIntegrationBranch,
} from './epic-coordinator.js';
import type { EpicRefreshResolveDispatchOutcome, EpicRefreshTarget } from './epic-coordinator.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { SpanContext } from '@opentelemetry/api';
import { startOperation, type Operation } from '../telemetry/operations.js';

const STDERR_TAIL_CAP = 8000;

const LIFECYCLE_SETTLE_GRACE_MS = 15_000;

const LIVE_RUN_LOG_EVENT_ID_OFFSET = 1_000_000_000;

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

/** A live ACP update, with an Attempt-local monotonic id for reconnect de-duplication. */
export interface LiveAttemptEvent {
  id: number;
  attemptId: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: { sessionUpdate: string; [key: string]: unknown };
}

export interface RunnerOptions {
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
        | 'verificationCommand'
        | 'reviewEnabled'
        | 'reviewPrompt'
        | 'reviewModel'
        | 'reviewHarness'
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

interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
  baseRev?: string;
  startDirty?: boolean;
}

interface ActiveRun {
  attemptId: number;
  taskId: number;
  child: ChildProcess;
  driver: AcpDriver;
  harnessId: string;
  harness: HarnessConfig;
  cwd: string;
  activity: string | null;
  agentFinished: boolean;
  escalateReason: string | null;
  steerQueue: string[];
  idle: boolean;
  externallySettled: boolean;
  steerable: boolean;
  steerSupported?: boolean;
  pauseRequested: boolean;
  verifyAbort: AbortController;
}

interface HealContext {
  reason: string;
  output: string;
  attempt: number;
  continuation: DeterministicContinuation;
  condensedContext: string | null;
}

/**
 * Thrown by {@link Runner.resolveBaseBranch} when a worktree Attempt's base branch
 * cannot be resolved to a real branch name: the base repo is on a detached HEAD
 * and the Task carries no explicit `baseBranch`. `reason` tells the operator how
 * to fix it: reattach the base repo to a branch, or set the Task's base.
 */
export class BaseBranchUnresolved extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'BaseBranchUnresolved';
  }
}

/**
 * Thrown inside {@link Runner.prepareWorkspace} when a worktree Attempt's resolved
 * base is an Epic integration branch (`epic/<ref>`) that does NOT currently
 * exist. A transient condition: the Runner settles the Run back to `ready` to
 * be re-picked rather than escalating.
 */
export class EpicBaseNotReady extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'EpicBaseNotReady';
  }
}

type TurnOutcome =
  | { kind: 'terminal' }
  | { kind: 'actionable-fail'; reason: string; output: string };

const EPIC_REFRESH_RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;

interface PersistSessionContext {
  task: TaskRow;
  run: AttemptRow;
  harness: HarnessConfig;
  workspace: Workspace;
  mcpServers: unknown[];
  attemptAtStart: AttemptRow;
  getSessionInit: () => AcpInitializeResult | undefined;
  setSessionRowId: (id: number) => void;
}

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

export class Runner {
  private readonly runOperations = new Map<number, Operation>();
  private active = new Map<number, ActiveRun>();
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
  private readonly epicMergeEvents: EpicMergeEventStore;
  private readonly settleCoordinator: AttemptSettleCoordinator;
  private readonly sessionRetirement: SessionRetirementHook | undefined;
  private readonly tailer: LiveUsageTailer;
  private readonly usage: UsageSampler;
  private readonly transcripts: TranscriptCapture;
  private readonly toolCallTotals = new Map<number, Map<string, number>>();
  private readonly lastTurnContextTokens = new Map<number, number>();
  private readonly pendingOperatorSeed = new Map<number, string>();
  private readonly pendingContinuation = new Map<number, DeterministicContinuation>();
  private readonly progressEvents = new Map<number, ProgressEvent[]>();
  private readonly progressSequences = new Map<number, number>();
  private readonly criticLogSequences = new Map<number, number>();
  private readonly outstandingProgressActions = new Map<number, ProgressEvent>();
  private readonly spendPollMs: number;
  private readonly spendGraceMs: number;
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
    this.epicMergeEvents = new EpicMergeEventStore(this.asyncDb);
    this.verificationAttempts = new VerificationAttemptStore(this.asyncDb);
    this.guardrailEvents = new GuardrailEventStore(this.asyncDb);
    this.sessionStore = new SessionStore(this.asyncDb);
    this.transcripts = new TranscriptCapture(this.sessionStore, this.verificationAttempts, this.getConfig);
    this.usage = new UsageSampler(
      this.attempts,
      (attemptId) => {
        const a = this.active.get(attemptId);
        return a ? { harnessId: a.harnessId, harness: a.harness, cwd: a.cwd, activity: a.activity } : undefined;
      },
      this.toolCallTotals,
    );
    this.settleCoordinator = new AttemptSettleCoordinator(
      this.taskService,
      this.attempts,
      (run) => this.events.onAttemptFinished?.(run),
      options.sessionRetirement,
    );
    this.sessionRetirement = options.sessionRetirement;
    this.tailer = new LiveUsageTailer(
      {
        sample: (attemptId) => this.usage.sampleSnapshot(attemptId),
        emit: (attemptId, snapshot) => this.events.onAttemptUsage?.({ attemptId, snapshot }),
        persist: (attemptId, snapshot) => {
          void this.attempts.update(attemptId, { liveUsage: JSON.stringify(snapshot) }).catch(() => {});
        },
      },
      options.tailerCadence,
    );
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * A verifier's live output, batched onto the Attempt's transient log stream
   * (the same channel the builder's ACP updates ride) as
   * `verification_output` updates, so the Verify/Review tab can tail a check
   * while it runs. Batched per ~400ms or 8 KiB so a chatty test runner doesn't
   * fan out one WebSocket frame per stdout write.
   */
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
      const seq = (this.progressSequences.get(attemptId) ?? 0) + 1;
      this.progressSequences.set(attemptId, seq);
      this.events.onAttemptLogEvent?.({
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
        if (pending.length >= 8_192) flush();
        else if (!timer) timer = setTimeout(flush, 400);
      },
      flush,
    };
  }

  /**
   * Relay one critic turn's ACP session updates onto the critic-log channel,
   * verbatim and keyed by the builder Attempt — the same event shape the builder
   * streams, so the running critic renders through the identical chat viewer.
   */
  private criticUpdateRelay(attemptId: number): (update: { sessionUpdate: string; [key: string]: unknown }) => void {
    return (update) => {
      const seq = (this.criticLogSequences.get(attemptId) ?? 0) + 1;
      this.criticLogSequences.set(attemptId, seq);
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
      [...this.active.values()].map(async (a) => ({
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
      return await this.beginRun(claimed);
    } catch (err) {
      await this.taskService.setState(taskId, 'ready');
      throw err;
    }
  }

  /**
   * Reject with guidance: the operator's guidance becomes the feedback of the
   * escalated Attempt and of the next one, the attempt budget restarts, and the
   * loop resumes on the same ticket. The next Attempt reuses the Task's existing
   * worktree and branch.
   */
  async resumeWithGuidance(task: TaskRow, guidance: string, startNow = false): Promise<void> {
    const run = (await this.attempts.listForTask(task.id)).at(-1);
    const escalated = (await this.attempts.listForTask(task.id)).findLast((attempt) => attempt.state === 'escalated');
    if (escalated) await this.attempts.setFeedback(escalated.id, guidance);
    let choice: 'full' | 'condensed' | undefined;
    let continuation: DeterministicContinuation | undefined;
    if (run) {
      continuation = await this.decideContinuation(task, run, await this.getWorkspace?.(task.workspaceId));
      choice = continuation.path === 'continued-session' ? 'full' : 'condensed';
    }
    await this.taskService.requeue(task.id, guidance, choice);
    if (startNow) {
      if (continuation) this.pendingContinuation.set(task.id, continuation);
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
    return this.beginRun(task, parent);
  }

  private async beginRun(task: TaskRow, parent?: SpanContext): Promise<AttemptRow> {
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
    const created = await this.attempts.create(task.id, snapshot);
    const pendingContinuation = this.pendingContinuation.get(task.id);
    if (pendingContinuation !== undefined) {
      this.pendingContinuation.delete(task.id);
      await this.attempts.setContinuation(created.id, pendingContinuation);
    }
    const run = created;
    const bound = await this.bindContinuationIfEligible(task, run);
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
    this.runOperations.set(bound.id, operation);
    void operation.run(async () => {
      try {
        await this.drive(task, bound, harness, operation.spanContext);
        await this.finishRunOperation(bound.id);
      } catch (error) {
        operation.fail(error instanceof Error ? error.message : String(error));
        this.runOperations.delete(bound.id);
      }
    });
    return bound;
  }

  operationParent(attemptId: number): SpanContext | undefined {
    return this.runOperations.get(attemptId)?.spanContext;
  }

  async finishRunOperation(attemptId: number): Promise<void> {
    const operation = this.runOperations.get(attemptId);
    if (!operation) return;
    const run = await this.attempts.get(attemptId);
    if (run.state === 'running') return;
    this.runOperations.delete(attemptId);
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

  private async resolveContinuationSource(
    task: TaskRow,
  ): Promise<{ prior: AttemptRow; session: SessionRow; trigger: ContinuationTrigger } | null> {
    const priors = await this.attempts.listForTask(task.id);
    for (let i = priors.length - 1; i >= 0; i--) {
      const prior = priors[i]!;
      if (prior.sessionRowId === null) continue;
      try {
        const session = await this.sessionStore.get(prior.sessionRowId);
        return { prior, session, trigger: 'human-reject' };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async bindContinuationIfEligible(task: TaskRow, run: AttemptRow): Promise<AttemptRow> {
    try {
      const src = await this.resolveContinuationSource(task);
      if (!src) return run;
      if (!this.resumeEligibilityFor(task, src.session).eligible) return run;

      const cacheWarmSeconds = configuredCacheWarmSeconds(this.getConfig(), task.harness);
      if (cacheWarmSeconds === undefined) return run;
      const plan = planSessionContinuation(src.trigger, sessionWarmthFacts(src.session, cacheWarmSeconds), Date.now());

      if (plan.mode === 'offer-choice' && task.continuationChoice === 'condensed') {
        return run;
      }

      const bound = await this.attempts.update(run.id, {
        sessionRowId: src.session.id,
        sessionId: src.session.harnessSessionId,
      });
      try {
        await this.sessionStore.reactivate(src.session.id, Date.now());
      } catch {
      }
      return bound;
    } catch {
      return run;
    }
  }

  private worktreePathForTask(task: TaskRow): string {
    return join(this.worktreesDir, `task-${task.id}`);
  }

  private dispatchCwd(task: TaskRow): string {
    return task.isolationMode === 'worktree' ? this.worktreePathForTask(task) : task.workingDir;
  }

  private resumeEligibilityFor(task: TaskRow, session: SessionRow) {
    const env: ResumeEnvironment = {
      harness: session.harness,
      adapterVersion: adapterVersion(task.harness),
      model: task.model,
      availablePermissionModes: session.permissionMode ? [session.permissionMode] : [],
      cwd: repoKey(this.dispatchCwd(task)),
    };
    const stored = { ...sessionFacts(session), cwd: repoKey(session.cwd) };
    return assessResumeEligibility(stored, env);
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
    for (const active of this.active.values()) {
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
    const active = [...this.active.values()].find((a) => a.taskId === taskId);
    if (!active || !active.steerable) return false;
    // ACP `promptRequired`: an idle session must not start an untracked turn.
    if (!active.idle && active.steerSupported !== false) {
      try {
        const res = await active.driver.steer([{ type: 'text', text }], { steering: { idleBehavior: 'promptRequired' } });
        if (res.outcome === 'injected') {
          active.steerSupported = true;
          const event = await this.attempts.appendEvent(active.attemptId, { type: 'lifecycle', payload: { event: 'steer_injected', text } });
          this.events.onAttemptEvent?.(event);
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
    return true;
  }

  /** Deliver the configured pause steer, then pause at the next prompt boundary. */
  async pause(taskId: number): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'working') return false;
    const active = [...this.active.values()].find((candidate) => candidate.taskId === taskId);
    if (!active || active.pauseRequested) return false;
    const message = resolvePauseMessage(await this.getWorkspace?.(task.workspaceId), this.getConfig());
    if (!(await this.steer(taskId, message))) return false;
    active.pauseRequested = true;
    return true;
  }

  /** Resume the still-running Attempt and exclude the paused interval from its
   * elapsed wall-clock budget before reattaching its durable Session. */
  async resume(taskId: number): Promise<boolean> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'paused') return false;
    const run = await this.attempts.getRunningForTask(taskId);
    if (!run) return false;
    const pausedFor = Math.max(0, Date.now() - task.updatedAt);
    await this.attempts.update(run.id, { startedAt: run.startedAt + pausedFor });
    await this.taskService.resume(taskId);
    try {
      await this.launchClaimed(taskId);
      return true;
    } catch (error) {
      await this.taskService.pause(taskId);
      throw error;
    }
  }

  /**
   * Continue a settled (escalated) Task's warm Session with an operator
   * message: when no Attempt is active but the Task's last Session-bound Attempt left a
   * Session that is BOTH resumable and still inside its harness warm window,
   * spawn a fresh Attempt bound to that Session whose FIRST turn is the operator's
   * message. Returns false (→ 409) when there is nothing warm to continue.
   */
  async steerSettled(taskId: number, text: string): Promise<boolean> {
    if ([...this.active.values()].some((a) => a.taskId === taskId)) return false;
    const task = await this.taskService.get(taskId);
    if (task.state !== 'escalated') return false;
    const src = await this.resolveContinuationSource(task);
    if (!src) return false;
    if (!this.resumeEligibilityFor(task, src.session).eligible) return false;
    const cacheWarmSeconds = configuredCacheWarmSeconds(this.getConfig(), task.harness);
    if (cacheWarmSeconds === undefined || Date.now() - src.session.lastActiveAt >= cacheWarmSeconds * 1000) return false;
    this.pendingOperatorSeed.set(taskId, text);
    try {
      await this.taskService.requeue(taskId, undefined, 'full');
      await this.start(taskId);
    } catch (err) {
      this.pendingOperatorSeed.delete(taskId);
      throw err;
    }
    return true;
  }

  private forActiveTask(taskId: number, fn: (active: ActiveRun) => void): boolean {
    for (const active of this.active.values()) {
      if (active.taskId === taskId) {
        fn(active);
        return true;
      }
    }
    return false;
  }

  /** Kill every active harness (process shutdown). */
  shutdown(): void {
    this.shuttingDown = true;
    for (const active of this.active.values()) {
      void this.tailer.stop(active.attemptId);
      active.verifyAbort.abort();
      this.kill(active);
    }
    this.active.clear();
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

  private async resolveBaseBranch(task: TaskRow): Promise<string> {
    if (task.mapRef !== null) {
      const branch = integrationBranchName(task.mapRef);
      if (task.baseBranch === branch) return branch;
      if (await Git.branchExists(task.workingDir, branch)) {
        throw new EpicBaseNotReady(
          `task ${task.id} is an Epic member (${branch}) whose base is not yet its integration branch ` +
            `(currently ${task.baseBranch ?? 'unassigned'}); it is retargeted on the next tracker poll — retry shortly`,
        );
      }
    }
    if (task.baseBranch) return task.baseBranch;
    const branch = await Git.symbolicBranch(task.workingDir);
    if (branch) return branch;
    await Git.assertRepo(task.workingDir);
    throw new BaseBranchUnresolved(
      `base repo ${task.workingDir} is on a detached HEAD with no current branch, and the Task has no explicit base branch; ` +
        'reattach the base repo to a branch (e.g. `git checkout <branch>`) or set an explicit base branch on the Task, then retry',
    );
  }

  private async prepareWorkspace(task: TaskRow, run: AttemptRow, resume = false): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') {
      const workspace: Workspace = { cwd: task.workingDir, env: {} };
      try {
        workspace.baseRev = await Git.revParse(task.workingDir, 'HEAD');
        workspace.startDirty = resume ? false : await Git.isDirty(task.workingDir);
      } catch {
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
      const baseBranch = persisted.baseBranch ?? (await this.resolveBaseBranch(task));
      if (!existsSync(path)) {
        await Git.addWorktreeCheckout(task.workingDir, path, branch);
      }
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }

    const baseBranch = await this.resolveBaseBranch(task);
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

  private async criticEnabledFor(task: TaskRow): Promise<boolean> {
    const ws = await this.getWorkspace?.(task.workspaceId);
    const { review } = resolveVerifiers(
      ws ?? { verificationCommand: null, reviewEnabled: null, reviewPrompt: null, reviewModel: null, reviewHarness: null },
      this.getConfig(),
    );
    return !!(review.enabled && review.prompt && review.model);
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

  private async noVerifiedHeadVerdict(
    task: TaskRow,
    mechanism: 'command' | 'critic',
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<VerifierVerdict> {
    const attempt = await this.latestAttemptFor(task);
    const persisted = await this.verificationAttempts.append(attempt.id, {
      mechanism,
      inputOid: '',
      verdict: 'inconclusive',
      summary: 'no committed branch head to verify',
      output: '',
    });
    const timeline = await this.attempts.createStep(attempt.id, {
      type: mechanism === 'command' ? 'verification' : 'review',
      logLocator: `verification_attempt:${persisted.id}`,
    });
    await this.updateStep(task.id, timeline.id, {
      state: 'failed', verdict: 'inconclusive', startedAt: persisted.ts, endedAt: Date.now(),
    });
    record('lifecycle', { event: 'verification', mechanism, verdict: 'inconclusive' });
    return { verifier: mechanism, verdict: 'inconclusive' };
  }

  private async runVerification(
    task: TaskRow,
    run: AttemptRow,
    head: string | null,
    signal: AbortSignal,
    record: (type: 'lifecycle', payload: unknown) => void,
    parent: SpanContext,
    criticEnabled = true,
  ): Promise<{ decision: VerificationDecision; ran: boolean }> {
    run = await this.attempts.get(run.id);
    const config = this.getConfig();
    const ws = await this.getWorkspace?.(task.workspaceId);
    const { commands, review } = resolveVerifiers(
      ws ?? { verificationCommand: null, reviewEnabled: null, reviewPrompt: null, reviewModel: null, reviewHarness: null },
      config,
    );

    const verdicts: VerifierVerdict[] = [];
    const oid = head;

    for (const command of commands) {
      if (!oid) {
        verdicts.push(await this.noVerifiedHeadVerdict(task, 'command', record));
      } else {
        mkdirSync(this.worktreesDir, { recursive: true });
        // The Step opens before the command runs so the Board badge, the Verify
        // tab and the timeline show it live — not only once its verdict lands.
        const label = [command.command, ...command.args].join(' ').trim();
        const timelineAttempt = await this.latestAttemptFor(task);
        const timelineStep = await this.attempts.createStep(timelineAttempt.id, { type: 'verification', command: command.command });
        await this.updateStep(task.id, timelineStep.id, { state: 'running', startedAt: Date.now() });
        record('lifecycle', { event: 'verification-started', mechanism: 'command', command: label });
        const relay = this.verificationOutputRelay(run.id, 'command', label);
        const attempt = await runCommandVerifier({
          repoDir: task.workingDir,
          verifiedHeadOid: oid,
          worktreePath: join(this.worktreesDir, `cmdverify-${run.id}`),
          command,
          signal,
          parent,
          attributes: { 'task.id': task.id, 'attempt.id': run.id },
          onOutput: relay.push,
        });
        relay.flush();
        const persisted = await this.verificationAttempts.append(timelineAttempt.id, commandAttemptToInput(attempt));
        await this.updateStep(task.id, timelineStep.id, {
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

    if (criticEnabled && review.enabled && review.prompt && review.model && verdicts.every((entry) => entry.verdict === 'pass')) {
      if (!oid) {
        verdicts.push(await this.noVerifiedHeadVerdict(task, 'critic', record));
      } else {
        const criticHarnessId = review.harness ?? task.harness;
        const criticHarness = config.harnesses[criticHarnessId as keyof typeof config.harnesses];
        if (!criticHarness) {
          throw new DomainError('validation', `critic harness '${criticHarnessId}' is not configured`);
        }
        const baseOid =
          run.branch && run.baseBranch
            ? await Git.mergeBase(task.workingDir, run.baseBranch, run.branch).catch(() => null)
            : null;
        const criticCwd = run.branch ? this.worktreePathForTask(task) : task.workingDir;
        // The worktree's code index dates from Attempt start; refresh it to the candidate head.
        if (run.branch) await indexWorktree(criticCwd);
        const timelineAttempt = await this.latestAttemptFor(task);
        const timelineStep = await this.attempts.createStep(timelineAttempt.id, { type: 'review' });
        await this.updateStep(task.id, timelineStep.id, { state: 'running', startedAt: Date.now() });
        record('lifecycle', { event: 'verification-started', mechanism: 'critic', model: review.model });
        const attempt = await runCritic({
          cwd: criticCwd,
          verifiedHeadOid: oid,
          ...(baseOid ? { baseOid } : {}),
          critic: { prompt: review.prompt!, model: review.model!, ...(review.harness ? { harness: review.harness } : {}) },
          fields: driveFields(task, this.urlFor),
          harness: criticHarness,
          harnessId: criticHarnessId,
          parent,
          attributes: { 'task.id': task.id, 'attempt.id': run.id },
          // `exactOptionalPropertyTypes` forbids an explicit `undefined`.
          ...(this.criticDrive ? { drive: this.criticDrive } : {}),
          onUpdate: this.criticUpdateRelay(run.id),
        });
        const persisted = await this.verificationAttempts.append(timelineAttempt.id, criticAttemptToInput(attempt));
        // The harness rarely has its transcript or usage flushed by the
        // session-end boundary, so both are resolved off the hot path.
        if (attempt.sessionId) {
          if (attempt.transcriptPath === null) {
            void this.transcripts.captureCriticTranscript({
              attemptId: persisted.id,
              sessionId: attempt.sessionId,
              harnessId: criticHarnessId,
              sessionLogDir: criticHarness.sessionLogDir,
            });
          }
          void this.transcripts.captureCriticUsage({
            attemptId: persisted.id,
            sessionId: attempt.sessionId,
            harnessId: criticHarnessId,
            cwd: criticCwd,
          });
        }
        await this.updateStep(task.id, timelineStep.id, {
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
      }
    }

    return { decision: combineVerdicts(verdicts), ran: verdicts.length > 0 };
  }

  private async runRebaseTask(
    task: TaskRow,
    attemptNumber: number,
    attemptStartedAt: number,
    worktreePath: string,
    baseBranch: string,
  ): Promise<{ ok: true; tip: string } | { ok: false; conflict: boolean; detail: string }> {
    const attempt = await this.attempts.ensureForRun(task.id, attemptNumber, attemptStartedAt);
    const row = await this.attempts.createStep(attempt.id, { type: 'rebase', logLocator: `git:rebase:${baseBranch}` });
    await this.updateStep(task.id, row.id, { state: 'running', startedAt: Date.now() });
    const baseOid = await Git.revParse(task.workingDir, baseBranch);
    const rebased = await Git.rebaseOnto(worktreePath, baseOid);
    if (!rebased.ok) {
      await this.updateStep(task.id, row.id, {
        state: 'failed',
        verdict: rebased.conflict ? 'fail' : 'inconclusive',
        endedAt: Date.now(),
        logLocator: `git:rebase:${baseBranch}@${baseOid}\n${rebased.detail}`,
      });
      return { ok: false, conflict: rebased.conflict, detail: rebased.detail };
    }
    await this.updateStep(task.id, row.id, {
      state: 'passed',
      verdict: 'pass',
      endedAt: Date.now(),
      logLocator: `git:rebase:${baseBranch}@${baseOid}`,
    });
    return { ok: true, tip: rebased.rebasedTip };
  }

  private async verificationFailTurn(
    task: TaskRow,
    decision: VerificationDecision,
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<TurnOutcome> {
    const attemptRow = await this.latestAttemptFor(task);
    const attempts = await this.verificationAttempts.list(attemptRow.id);
    const output = attempts[attempts.length - 1]?.output ?? '';
    record('lifecycle', { event: 'verification-actionable-fail', reason: decision.reason });
    const reason = decision.outcome === 'block' ? decision.reason : `verification ${decision.outcome}: ${decision.reason}`;
    return { kind: 'actionable-fail', reason, output };
  }

  private async finalizeWorkspace(task: TaskRow, run: AttemptRow, attemptNumber: number, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    const { repoDir, path } = workspace.worktree;
    await Git.commitAll(path, `harmonic: task ${task.id} attempt ${attemptNumber}`).catch(() => {});
    const sessionRowId = (await this.attempts.get(run.id)).sessionRowId;
    let retained = false;
    if (sessionRowId != null) {
      try {
        await this.sessionStore.bindWorktree(sessionRowId, repoDir, path, Date.now());
        retained = true;
      } catch {
        retained = false;
      }
    }
    if (!retained) {
      await Git.removeWorktree(repoDir, path).catch(() => {});
    }
  }

  private async drive(task: TaskRow, run: AttemptRow, harness: HarnessConfig, parent: SpanContext): Promise<void> {
    const workspace = await this.getWorkspace?.(task.workspaceId);
    const maxAttempts = resolveScoped('maxAttempts', workspace?.maxAttempts, this.getConfig().maxAttempts);
    let attemptNumber = run.number;
    const budgetBase = await this.attempts.budgetBase(task.id);
    let healCtx: HealContext | undefined;
    try {
      for (;;) {
      const outcome = await this.driveOnce(task, run, harness, parent, healCtx, attemptNumber);
      if (outcome.kind === 'terminal') return;
      run = await this.attempts.get(run.id);
      const feedback = [outcome.reason, outcome.output].filter(Boolean).join('\n\n');
      if (attemptNumber - budgetBase >= maxAttempts) {
        await this.settleEscalated(task, run, `attempt ${attemptNumber - budgetBase} of ${maxAttempts} failed: ${outcome.reason}`, { feedback });
        return;
      }
      await this.attempts.finish(run.id, 'failed', Date.now(), feedback);
      const continuation = await this.decideContinuation(task, run, workspace);
      attemptNumber += 1;
      const closedRunId = run.id;
      this.toolCallTotals.delete(closedRunId);
      this.lastTurnContextTokens.delete(closedRunId);
      this.progressEvents.delete(closedRunId);
      this.progressSequences.delete(closedRunId);
      this.criticLogSequences.delete(closedRunId);
      this.outstandingProgressActions.delete(closedRunId);
      const nextAttempt = await this.attempts.ensureForRun(task.id, attemptNumber, Date.now());
      run = await this.attempts.update(nextAttempt.id, {
        branch: run.branch,
        baseBranch: run.baseBranch,
        sessionRowId: run.sessionRowId,
        sessionId: run.sessionId,
        verifiedHeadOid: run.verifiedHeadOid,
      });
      await this.attempts.setContinuation(run.id, continuation);
      healCtx = {
        reason: outcome.reason,
        output: outcome.output,
        attempt: attemptNumber - 1,
        continuation,
        condensedContext: continuation.path === 'new-session-condensed' ? await this.condensedContext(run) : null,
      };
      }
    } finally {
      this.toolCallTotals.delete(run.id);
      this.lastTurnContextTokens.delete(run.id);
      this.progressEvents.delete(run.id);
      this.progressSequences.delete(run.id);
      this.criticLogSequences.delete(run.id);
      this.outstandingProgressActions.delete(run.id);
    }
  }

  private async decideContinuation(
    task: TaskRow,
    run: AttemptRow,
    workspace: Awaited<ReturnType<NonNullable<RunnerOptions['getWorkspace']>>>,
  ): Promise<DeterministicContinuation> {
    const now = Date.now();
    const session = run.sessionRowId === null ? null : await this.sessionStore.get(run.sessionRowId).catch(() => null);
    const persisted = run.usage ? (JSON.parse(run.usage) as AttemptUsage).contextTokens ?? null : null;
    const contextTokens = (await this.usage.latestSnapshot(run.id))?.contextTokens ?? this.lastTurnContextTokens.get(run.id) ?? persisted;
    return decideAttemptContinuation({
      cacheWarmSeconds: configuredCacheWarmSeconds(this.getConfig(), task.harness) ?? 0,
      contextTokens,
      lastActiveAt: session?.lastActiveAt ?? now,
      contextReuseTokenLimit: resolveScoped('contextReuseTokenLimit', workspace?.contextReuseTokenLimit, this.getConfig().contextReuseTokenLimit),
      now,
    });
  }

  private async condensedContext(run: AttemptRow): Promise<string | null> {
    if (run.sessionRowId === null) return null;
    const session = await this.sessionStore.get(run.sessionRowId).catch(() => null);
    if (!session) return null;
    const current = await this.attempts.get(run.id);
    const events = await this.attempts.listEvents(run.id);
    return [
      '## Prior session (condensed)',
      'This attempt starts a fresh Session under the deterministic continuation rule.',
      `Prior Session: ${session.harness} / ${session.model} / ${session.harnessSessionId}`,
      `Verified head: ${current.verifiedHeadOid ?? '(none produced)'}`,
      `Attempt events: ${events.length}.`,
    ].join('\n');
  }

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
    const config = this.getConfig();
    const host = (await this.taskService.list({ state: 'working' })).find((task) => task.baseBranch === branch);
    const harnessId = host?.harness ?? config.defaults.harness;
    const harness = config.harnesses[harnessId as keyof AppConfig['harnesses']];
    if (!harness) {
      return escalated(`harness '${harnessId}' is not configured to run the refresh corrective turn for ${branch}: ${detail}`);
    }
    const model = host?.model ?? harness.defaultModel;

    mkdirSync(this.worktreesDir, { recursive: true });
    const worktreePath = join(this.worktreesDir, `epic-refresh-${target.ref}`);
    try {
      await Git.addWorktreeCheckout(target.repoDir, worktreePath, branch);
    } catch (err) {
      return escalated(`could not check out ${branch} for the refresh corrective turn (${String(err)}); refresh conflict: ${detail}`);
    }
    let reproduced: { ok: boolean; detail?: string };
    try {
      reproduced = await Git.mergeLeavingConflict(worktreePath, target.defaultBranch);
    } catch (err) {
      await Git.removeWorktree(target.repoDir, worktreePath).catch(() => {});
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
        const drive = this.criticDrive ?? createAcpCriticDrive();
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
          timeoutMs: EPIC_REFRESH_RESOLVE_TIMEOUT_MS,
        });
      }
    } catch {
    } finally {
      await Git.removeWorktree(args.target.repoDir, args.worktreePath).catch(() => {});
    }
  }

  /**
   * Integrate an Epic's `epic/<ref>` branch into the default branch under the
   * one merge policy. The harness/model is resolved from a live member (else
   * the Workspace default). Escalation is returned to the caller, which owns
   * the Epic-level escalation surface, rather than settled here.
   */
  async mergeEpicIntegration(input: {
    workspaceId: number;
    repoDir: string;
    epicRef: number;
    defaultBranch: string;
    integrationBranch: string;
    runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
  }): Promise<MergePolicyOutcome> {
    const config = this.getConfig();
    const host = (await this.taskService.list({ state: 'working' })).find((task) => task.baseBranch === input.integrationBranch);
    const harnessId = host?.harness ?? config.defaults.harness;
    const harness = config.harnesses[harnessId as keyof AppConfig['harnesses']];
    const model = host?.model ?? harness?.defaultModel ?? '';
    const deps: MergePolicyDeps = {
      resolveConflictTurn: async (ctx) => {
        try {
          if (!harness) return;
          const drive = this.criticDrive ?? createAcpCriticDrive();
          const prompt =
            `## Epic integration merge conflict resolution (turn ${ctx.turn})\n` +
            `Merging the Epic integration branch \`${ctx.taskBranch}\` into \`${ctx.baseBranch}\` conflicted in:\n` +
            ctx.unmergedPaths.map((path) => `- ${path}`).join('\n') +
            `\n\nThis checkout (\`${ctx.baseDir}\`) has \`${ctx.baseBranch}\` checked out with that merge in progress — conflict ` +
            `markers are present in the listed paths. Resolve the conflicts so the result keeps both \`${ctx.baseBranch}\`'s and ` +
            `\`${ctx.taskBranch}\`'s work, then \`git add\` the resolved paths. Do not run \`git commit\`, do not create or switch ` +
            `branches, do not push, and do not change anything beyond what resolving this merge requires.`;
          await drive.run({
            harness,
            harnessId,
            model,
            cwd: ctx.baseDir,
            prompt,
            timeoutMs: EPIC_REFRESH_RESOLVE_TIMEOUT_MS,
          });
        } catch {
        }
      },
      runPostMergeCheck: input.runPostMergeCheck,
      escalate: async () => {},
      onStep: (step) => persistStep(step),
    };
    let persistChain: Promise<unknown> = Promise.resolve();
    const persistStep = (step: MergeStepEvent): void => {
      persistChain = persistChain
        .then(async () => {
          if (step.step === 'started') await this.epicMergeEvents.clear(input.workspaceId, input.epicRef);
          await this.epicMergeEvents.append(input.workspaceId, input.epicRef, step);
          this.events.onEpicMergeStep?.({ workspaceId: input.workspaceId, epicRef: input.epicRef });
        })
        .catch((err) => logger.warn('epic merge step persist failed', { error: err instanceof Error ? err.message : String(err) }));
    };
    const outcome = await runMergePolicy(
      {
        baseDir: input.repoDir,
        baseBranch: input.defaultBranch,
        taskBranch: input.integrationBranch,
        conflictResolveTurns: host?.conflictResolveTurns ?? config.defaults.conflictResolveTurns,
        postMergeCheck: config.merge.postMergeCheck,
      },
      deps,
    );
    await persistChain;
    if (outcome.kind === 'merged') {
      await this.postMerge?.({ repoDir: input.repoDir, baseBranch: input.defaultBranch });
    }
    return outcome;
  }

  private mergePolicyDeps(
    task: TaskRow,
    run: AttemptRow,
    record: (type: 'lifecycle', payload: unknown) => void,
    signal: AbortSignal,
    patch: Partial<AttemptRow>,
  ): MergePolicyDeps {
    return {
      onStep: (event) => record('lifecycle', { event: 'merge-step', step: event }),
      resolveConflictTurn: async (ctx) => {
        try {
          const config = this.getConfig();
          const harnessId = task.harness;
          const harness = config.harnesses[harnessId as keyof typeof config.harnesses];
          if (!harness) return;
          const drive = this.criticDrive ?? createAcpCriticDrive();
          const prompt =
            `## Merge conflict resolution (turn ${ctx.turn})\n` +
            `Merging \`${ctx.taskBranch}\` into \`${ctx.baseBranch}\` conflicted in:\n` +
            ctx.unmergedPaths.map((path) => `- ${path}`).join('\n') +
            `\n\nThis checkout (\`${ctx.baseDir}\`) has \`${ctx.baseBranch}\` checked out with that merge in progress — conflict ` +
            `markers are present in the listed paths. Resolve the conflicts so the result keeps both \`${ctx.baseBranch}\`'s and ` +
            `\`${ctx.taskBranch}\`'s work, then \`git add\` the resolved paths. Do not run \`git commit\`, do not create or switch ` +
            `branches, do not push, and do not change anything beyond what resolving this merge requires.`;
          await drive.run({
            harness,
            harnessId,
            model: task.model,
            cwd: ctx.baseDir,
            prompt,
            timeoutMs: EPIC_REFRESH_RESOLVE_TIMEOUT_MS,
          });
        } catch {
        }
      },
      runPostMergeCheck: async (mergeOid, baseDir) => {
        const config = this.getConfig();
        const ws = await this.getWorkspace?.(task.workspaceId);
        const { commands } = resolveVerifiers(
          ws ?? { verificationCommand: null, reviewEnabled: null, reviewPrompt: null, reviewModel: null, reviewHarness: null },
          config,
        );
        if (commands.length === 0) return { pass: true, output: '' };
        mkdirSync(this.worktreesDir, { recursive: true });
        const timelineAttempt = await this.latestAttemptFor(task);
        for (const command of commands) {
          const attempt = await runCommandVerifier({
            repoDir: baseDir,
            verifiedHeadOid: mergeOid,
            worktreePath: join(this.worktreesDir, `postmerge-${run.id}`),
            command,
            signal,
            attributes: { 'task.id': task.id, 'attempt.id': run.id },
          });
          await this.verificationAttempts.append(timelineAttempt.id, commandAttemptToInput(attempt));
          record('lifecycle', { event: 'verification', mechanism: 'command', verdict: attempt.verdict, summary: attempt.summary });
          if (attempt.verdict !== 'pass') return { pass: false, output: attempt.output };
        }
        return { pass: true, output: '' };
      },
      escalate: async (reason) => {
        await this.settleEscalated(task, run, reason, patch);
      },
    };
  }

  /**
   * Operator Accept runs the identical one merge policy the automated path
   * does. The escalated Attempt is already terminal, so escalation is returned to
   * the caller rather than settled here.
   */
  async mergeAcceptedBranch(task: TaskRow, run: AttemptRow): Promise<MergePolicyOutcome> {
    const record = (type: 'lifecycle', payload: unknown) => this.recordRunEvent(task, run, type, payload);
    const deps: MergePolicyDeps = {
      ...this.mergePolicyDeps(task, run, record, new AbortController().signal, {}),
      escalate: async () => {},
    };
    const operation = startOperation({ type: 'attempt', attributes: { 'task.id': task.id, 'attempt.id': run.id } });
    const outcome = await operation
      .run(async () =>
        runMergePolicy(
          {
            baseDir: task.workingDir,
            baseBranch: run.baseBranch!,
            taskBranch: run.branch!,
            conflictResolveTurns: task.conflictResolveTurns,
            postMergeCheck: this.getConfig().merge.postMergeCheck,
            spanAttributes: { 'task.id': task.id, 'attempt.id': run.id },
          },
          deps,
        ),
      )
      .finally(() => operation.end());
    if (outcome.kind === 'merged') {
      record('lifecycle', { event: 'merged', oid: outcome.mergeOid, baseBranch: run.baseBranch });
      await this.postMerge?.({ repoDir: task.workingDir, baseBranch: run.baseBranch! });
    } else {
      record('lifecycle', { event: 'escalated', reason: outcome.message, gate: outcome.reason });
    }
    return outcome;
  }

  /**
   * The candidate commit an operator Accept would merge: a worktree Attempt's
   * branch tip once it has commits ahead of its base, or a direct Attempt's
   * captured `verifiedHeadOid`. Null means there is nothing to accept.
   */
  async candidateHead(task: TaskRow, run: AttemptRow): Promise<string | null> {
    if (task.isolationMode === 'worktree') {
      if (run.branch && run.baseBranch && (await Git.commitsAhead(task.workingDir, run.baseBranch, run.branch)) > 0) {
        return await Git.revParse(task.workingDir, run.branch);
      }
      return null;
    }
    return run.verifiedHeadOid ?? null;
  }

  /**
   * Verify a candidate for an operator Accept, recorded onto this Attempt's
   * event log exactly like an automated verify pass.
   */
  async verifyCandidateForAccept(task: TaskRow, run: AttemptRow, head: string): Promise<VerificationDecision> {
    const record = (type: 'lifecycle', payload: unknown) => this.recordRunEvent(task, run, type, payload);
    const operation = startOperation({ type: 'attempt', attributes: { 'task.id': task.id, 'attempt.id': run.id } });
    const { decision } = await operation
      .run(async () => this.runVerification(task, run, head, new AbortController().signal, record, operation.spanContext))
      .finally(() => operation.end());
    return decision;
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

  private async driveOnce(
    task: TaskRow,
    run: AttemptRow,
    harness: HarnessConfig,
    parent: SpanContext,
    healCtx?: HealContext,
    attemptNumber = run.number,
  ): Promise<TurnOutcome> {
    const record = (type: 'permission_request' | 'lifecycle', payload: unknown) => {
      this.recordRunEvent(task, run, type, payload);
    };
    const attemptAtStart = await this.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
    const toolCalls = this.toolCallTotals.get(run.id) ?? (await this.attempts.listToolCalls(attemptAtStart.id));
    this.toolCallTotals.set(run.id, toolCalls);
    const progressEvents = this.progressEvents.get(run.id) ?? [];
    this.progressEvents.set(run.id, progressEvents);
    const turn = new TurnState(attemptAtStart, toolCalls, progressEvents);
    const flushToolCalls = async () => {
      await this.attempts.replaceToolCalls(turn.attemptAtStart.id, turn.toolCalls);
    };

    const opensAttempt = (await this.attempts.listSteps(turn.attemptAtStart.id)).length === 0;

    const advanceTask = async (to: 'verifying' | 'merging') => {
      const attempt = await this.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
      const rows = await this.attempts.listSteps(attempt.id);
      const implementation = rows.find((row) => row.type === 'implementation' && row.state === 'running');
      if (to === 'verifying' && implementation) {
        await this.updateStep(task.id, implementation.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
      }
    };

    let escalating: string | null = null;
    const autoDriven = this.autoDrive?.handles(task) ?? false;

    let child: ChildProcess;
    let workspace: Workspace;
    let mcpServers: unknown[] = [];
    // codex-acp can exit non-zero mid-handshake with no ACP error; the cause is
    // only on stderr. Draining the pipe also prevents backpressure.
    let stderrTail = '';
    let stderrFlushed: Promise<void> = Promise.resolve();
    let rebaseConflict = false;
    try {
      workspace = await this.prepareWorkspace(task, run, healCtx !== undefined);
      if (opensAttempt && workspace.worktree) {
        const baseBranch = (await this.attempts.get(run.id)).baseBranch ?? await this.resolveBaseBranch(task);
        const rebase = await this.runRebaseTask(task, attemptNumber, run.startedAt, workspace.worktree.path, baseBranch);
        if (!rebase.ok) {
          if (!rebase.conflict) throw new Error(`rebase onto ${baseBranch} failed: ${rebase.detail}`);
          rebaseConflict = true;
          record('lifecycle', { event: 'rebase-conflict', baseBranch });
        }
      }
      const steps = await this.attempts.listSteps(turn.attemptAtStart.id);
      if (!steps.some((row) => row.type === 'implementation' && row.state === 'running')) {
        const implementation = await this.attempts.createStep(turn.attemptAtStart.id, { type: 'implementation', logLocator: 'session:pending' });
        await this.updateStep(task.id, implementation.id, { state: 'running', startedAt: Date.now() });
      }
      this.gitBreaker?.recordSuccess(repoKey(task.workingDir));
      if (this.keys && this.mcpUrl) {
        const runKey = await this.keys.mint(run.id);
        workspace.env.HARMONIC_API_KEY = runKey;
        workspace.env.HARMONIC_MCP_URL = this.mcpUrl;
        mcpServers = adapterFor(task.harness).mcpServers({ url: this.mcpUrl, token: runKey });
      }
      if (this.shuttingDown) return { kind: 'terminal' };
      child = this.spawnHarness(task, harness, workspace.cwd, workspace.env, autoDriven);
      if (child.pid !== undefined) {
        await this.attempts.update(run.id, { pid: child.pid, pgid: child.pid, procStartToken: readProcStartToken(child.pid) });
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
      try {
        void Promise.resolve(this.keys?.revoke(run.id)).catch(() => {});
      } catch {
      }
      if (err instanceof EpicBaseNotReady) {
        await this.coordinateSettle(task, run, 'failed', {
          runState: 'failed',
          taskAction: 'ready',
          reason: err.reason,
        });
      } else if (err instanceof BaseBranchUnresolved) {
        await this.settleEscalated(task, run, err.reason, {});
      } else if (err instanceof GitError) {
        const cls = classifyGitFailure([err.stderr, err.message].filter(Boolean).join('\n'));
        const failure = this.gitBreaker?.recordFailure(repoKey(task.workingDir));
        if (cls === 'permanent' || failure?.opened) {
          await this.settleEscalated(task, run, `git workspace preparation failed (${cls}): ${err.message}`, {});
        } else {
          await this.coordinateSettle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: err.message });
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
        await this.taskService.pause(task.id);
        record('lifecycle', { event: 'paused' });
        await finalize();
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
      if (this.shuttingDown) return { kind: 'terminal' };
      const usage = await this.usage.collectUsageSafe({ harnessId: task.harness, harness, cwd: workspace.cwd, attemptId: run.id, promptResult: undefined });
      this.noteModelMismatch(task, usage, record);
      const patch = { usage: usage ? JSON.stringify(usage) : null };
      if (escalating) {
        record('lifecycle', { event: 'escalated', reason: escalating });
        await this.settleEscalated(task, run, escalating, patch);
        return { kind: 'terminal' };
      }
      if ((await this.attempts.get(run.id)).state !== 'running') {
        await this.attempts.update(run.id, patch);
        return { kind: 'terminal' };
      }
      await this.attempts.update(run.id, patch);
      return { kind: 'actionable-fail', reason, output: '' };
    } finally {
      guardrails.disarm();
      driver.fail(new Error('run finished'));
      driver.dispose();
      this.active.delete(run.id);
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
      events: this.events,
      record,
      nextProgressSequence: () => {
        const seq = (this.progressSequences.get(run.id) ?? 0) + 1;
        this.progressSequences.set(run.id, seq);
        return seq;
      },
      outstandingAction: (event) => this.outstandingProgressActions.set(run.id, event),
      completeOutstandingAction: (event) => {
        const outstanding = this.outstandingProgressActions.get(run.id);
        if (outstanding && (event.ref === undefined || outstanding.ref === undefined || event.ref === outstanding.ref)) {
          this.outstandingProgressActions.delete(run.id);
        }
      },
    });
    const driver = new AcpDriver(
      child,
      listeners,
      this.getConfig().guardrails.promptInactivityTimeoutMinutes * 60_000,
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
      verifyAbort: new AbortController(),
    };
    this.active.set(run.id, active);
    turn.toolCallFlushTimer = setInterval(() => void flushToolCalls().catch(() => {}), 10_000);
    turn.toolCallFlushTimer.unref?.();
    const guardrails = new GuardrailSupervisor(
      {
        attempts: this.attempts,
        guardrailEvents: this.guardrailEvents,
        getWorkspace: this.getWorkspace,
        sampleSnapshot: (attemptId) => this.usage.sampleSnapshot(attemptId),
        spendPollMs: this.spendPollMs,
        spendGraceMs: this.spendGraceMs,
      },
      {
        taskId: task.id,
        workspaceId: task.workspaceId,
        attemptId: run.id,
        attemptNumber,
        progressTrace: turn.progressEvents,
        attemptForTrip: () => this.latestAttemptFor(task),
        outstandingAction: () => this.outstandingProgressActions.get(run.id),
        record: (payload) => record('lifecycle', payload),
        settle: async (now, reason) => {
          active.externallySettled = true;
          await this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
        },
        abort: () => active.verifyAbort.abort(),
        kill: () => this.kill(active),
        isSettled: () => active.externallySettled,
        isFinishing: () => active.agentFinished || active.escalateReason != null,
        hasPendingSteer: () => active.steerQueue.length > 0,
        pushSteer: (text) => active.steerQueue.push(text),
      },
    );
    listeners.setRuntime({ active, driver, guardrails });
    let finalized = false;
    const finalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      if (turn.sessionRowId !== undefined) {
        await this.sessionStore.touch(turn.sessionRowId, Date.now()).catch(() => {});
      }
      await this.tailer.stop(run.id);
      turn.clearTimer();
      await flushToolCalls().catch(() => {});
      this.usage.dropReader(run.id);
      this.kill(active);
      try {
        void Promise.resolve(this.keys?.revoke(run.id)).catch(() => {});
      } catch {
      }
      await this.finalizeWorkspace(task, run, attemptNumber, workspace).catch(() => {});
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
        await this.persistSession(continueSessionId, persistCtx);
      } else {
        record('lifecycle', { event: 'session-reload-declined', reason: outcome.reason, detail: outcome.detail });
        await driver.handshake({
          cwd: workspace.cwd,
          mcpServers,
          modelId,
          onInitialize: listeners.onInitialize,
          onSessionCreated: (sid) => this.persistSession(sid, persistCtx),
        });
      }
    } else {
      await driver.handshake({
        cwd: workspace.cwd,
        mcpServers,
        modelId,
        onInitialize: listeners.onInitialize,
        onSessionCreated: (sid) => this.persistSession(sid, persistCtx),
      });
    }
    this.tailer.start(run.id);
    await guardrails.prime();
    guardrails.armWallClock();
    guardrails.armToolTimeout();
    guardrails.armSpend();
    if (autoDriven) {
      const adapter = adapterFor(task.harness);
      const mode = adapter.unattendedPermissionMode(driver.availableModes);
      if (!mode) {
        if (adapter.requiresUnattendedPermissionMode) {
          throw new Error(
            `harness '${task.harness}' offers no unattended permission mode ` +
              `(available: ${driver.availableModes.join(', ') || 'none'})`,
          );
        }
      } else {
        await driver.setMode(mode);
        record('lifecycle', { event: 'mode_set', mode });
        if (turn.sessionRowId !== undefined) {
          try {
            await this.sessionStore.setPermissionMode(turn.sessionRowId, mode, Date.now());
          } catch {
          }
        }
      }
    }
    let promptText = autoDriven
      ? await this.autoDrive!.prompt(task)
      : promptForTask(
          { ...task, workingDir: workspace.cwd },
          resolveTaskPrompt(await this.getWorkspace?.(task.workspaceId), this.getConfig()),
        );
    const operatorSeed = this.pendingOperatorSeed.get(task.id);
    if (operatorSeed !== undefined) this.pendingOperatorSeed.delete(task.id);
    let condensed: string | null = null;
    if (operatorSeed !== undefined && !healCtx) {
      promptText = `## Operator message\n\n${operatorSeed}`;
    } else if (healCtx) {
      promptText = `${promptText}\n\n## Previous attempt failed — fix required (self-heal ${healCtx.attempt})\n` +
        `Your previous attempt did not pass:\n${healCtx.reason}\n\n${healCtx.output}\n\nFix the cause so the full verification suite passes, then finish.`;
      condensed = healCtx.condensedContext ?? null;
    } else if (task.continuationChoice === 'condensed') {
      const src = await this.resolveContinuationSource(task);
      condensed = src ? await this.condensedContext(src.prior) : null;
    }
    if (rebaseConflict) {
      promptText =
        `${promptText}\n\n## Rebase conflict — resolve first\n` +
        `Harmonic rebased your branch onto its base and the rebase stopped with conflicts left in progress in this checkout. ` +
        `Inspect the conflicted files (\`git status\`), resolve them, stage them, and run \`git rebase --continue\` before doing anything else.`;
    }
    if (condensed) promptText = `${promptText}\n\n${condensed}`;
    if (codeIndexRepoId) promptText = `${promptText}${codeIndexRepoGuidance(codeIndexRepoId)}`;
    await this.attempts.update(run.id, { prompt: promptText });
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
      if (!autoDriven || active.agentFinished || attempt > (await this.autoDrive!.continueAttempts(task))) {
        break;
      }
      record('lifecycle', { event: 'continue', attempt });
      promptText = await this.autoDrive!.continuePrompt(task);
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
        await Git.commitAll(workspace.cwd, `harmonic: task ${task.id} attempt ${attemptNumber}`).catch(() => {});
      }
      const [head, base] = await Promise.all([
        Git.revParse(workspace.cwd, 'HEAD').catch(() => null),
        workspace.baseRev ? Git.revParse(workspace.cwd, workspace.baseRev).catch(() => null) : Promise.resolve(null),
      ]);
      if (head && head !== base) {
        implementationHead = head;
        await this.attempts.update(run.id, { verifiedHeadOid: head });
      } else if (run.verifiedHeadOid) {
        implementationHead = run.verifiedHeadOid;
      } else if (active.agentFinished && head) {
        noChangeFinishHead = head;
      }
    }
    await finalize();
    const usage = await this.usage.collectUsageSafe({
      harnessId: task.harness,
      harness,
      cwd: workspace.cwd,
      attemptId: run.id,
      promptResult: result,
    });
    if (usage?.contextTokens != null) this.lastTurnContextTokens.set(run.id, usage.contextTokens);
    this.noteModelMismatch(task, usage, record);
    const patch = {
      stopReason: result.stopReason ?? null,
      usage: usage ? JSON.stringify(usage) : null,
    };
    if (escalating) {
      record('lifecycle', { event: 'escalated', reason: escalating });
      await this.settleEscalated(task, run, escalating, patch);
      return { kind: 'terminal' };
    }
    if (listeners.stoppedShort) {
      record('lifecycle', { event: 'stopped-short', reason: listeners.stoppedShort });
      return { kind: 'actionable-fail', reason: listeners.stoppedShort, output: '' };
    }
    await advanceTask('verifying');
    let noChange = false;
    if (noChangeFinishHead) {
      if (!(await this.criticEnabledFor(task))) {
        const reason = 'the agent finished without changing any files and no critic is configured to judge whether that is correct';
        record('lifecycle', { event: 'escalated', reason });
        await this.settleEscalated(task, run, reason, patch);
        return { kind: 'terminal' };
      }
      implementationHead = noChangeFinishHead;
      noChange = true;
    }
    const { decision, ran: verifierRan } = await this.runVerification(
      task,
      run,
      implementationHead,
      active.verifyAbort.signal,
      record,
      parent,
    );
    if (this.shuttingDown) return { kind: 'terminal' };
    if (active.externallySettled) {
      await finalize();
      return { kind: 'terminal' };
    }
    if (decision.outcome === 'block') {
      return await this.verificationFailTurn(task, decision, record);
    }
    if (decision.outcome !== 'proceed') {
      if ((await this.attempts.get(run.id)).verifiedHeadOid == null) {
        const reason = `verification ${decision.outcome}: ${decision.reason}`;
        record('lifecycle', { event: 'escalated', reason });
        await this.settleEscalated(task, run, reason, patch);
        return { kind: 'terminal' };
      }
      return await this.verificationFailTurn(task, decision, record);
    }
    if (afkUnresolved && (!verifierRan || (await this.attempts.get(run.id)).verifiedHeadOid == null)) {
      record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal and no verifier vouched for the work' });
      return { kind: 'actionable-fail', reason: 'attempt ended without an execution-complete (finish_task) signal', output: '' };
    }
    const diff = await this.diffSnapshotFor(task, run.id);
    const current = await this.attempts.get(run.id);
    const worktreeMerge = task.isolationMode === 'worktree';
    const deps = this.mergePolicyDeps(task, run, record, active.verifyAbort.signal, patch);
    const mergeWorktreeBranch = async (): Promise<boolean> => {
      await this.taskService.setMergeStatus(task.id, 'merging');
      const outcome = await runMergePolicy(
        {
          baseDir: task.workingDir,
          baseBranch: current.baseBranch!,
          taskBranch: current.branch!,
          conflictResolveTurns: task.conflictResolveTurns,
          postMergeCheck: this.getConfig().merge.postMergeCheck,
        },
        deps,
      );
      if (outcome.kind === 'escalated') {
        record('lifecycle', { event: 'escalated', reason: outcome.message, gate: outcome.reason });
        if (outcome.reason === 'conflict') await this.taskService.setMergeStatus(task.id, 'resolving-conflicts');
        return false;
      }
      record('lifecycle', { event: 'merged', oid: outcome.mergeOid, baseBranch: current.baseBranch });
      await this.postMerge?.({ repoDir: task.workingDir, baseBranch: current.baseBranch! });
      return true;
    };
    if (!autoDriven) {
      if (!noChange && worktreeMerge && !(await mergeWorktreeBranch())) {
        return { kind: 'terminal' };
      }
      await advanceTask('merging');
      await this.settleAutoCompleted(task, run, { ...patch, ...diff });
      return { kind: 'terminal' };
    }
    const mergeFate = await this.autoDrive!.mergeFateFor(task);
    if (!noChange && worktreeMerge && mergeFate === 'auto-merge' && !(await mergeWorktreeBranch())) {
      return { kind: 'terminal' };
    }
    const outcome = noChange
      ? (await this.autoDrive!.closeCompleted(task))
        ? 'completed'
        : 'escalate'
      : await this.autoDrive!.onCompleted(task, await this.attempts.get(run.id));
    if (outcome === 'escalate') {
      record('lifecycle', { event: 'escalated', reason: 'merge fate could not be applied' });
      await this.settleEscalated(task, run, 'merge fate could not be applied', patch);
    } else {
      await advanceTask('merging');
      await this.settleAutoCompleted(task, run, { ...patch, ...diff });
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

  private async persistSession(harnessSessionId: string, ctx: PersistSessionContext): Promise<void> {
    const { task, run, harness, workspace, mcpServers, attemptAtStart } = ctx;
    void this.attempts.update(run.id, { sessionId: harnessSessionId }).catch(() => {});
    try {
      const transcriptResolver = adapterFor(task.harness).usage?.resolveTranscriptPath;
      const transcriptPath = await transcriptResolver?.({
        sessionLogDir: harness.sessionLogDir,
        sessionId: harnessSessionId,
      });
      const session = await this.sessionStore.recordDispatch({
        harness: task.harness,
        harnessSessionId,
        model: task.model,
        cwd: workspace.cwd,
        workspaceId: task.workspaceId,
        ...(transcriptPath !== undefined ? { transcriptPath } : {}),
        mcpTemplates: mcpServers,
        capabilities: ctx.getSessionInit(),
        adapterVersion: adapterVersion(task.harness),
        now: Date.now(),
      });
      ctx.setSessionRowId(session.id);
      void this.attempts.update(run.id, { sessionRowId: session.id }).catch(() => {});
      void this.attempts.listSteps(attemptAtStart.id).then(async (steps) => {
        const implementation = steps.find((row) => row.type === 'implementation' && row.state === 'running');
        if (implementation) await this.attempts.updateStep(implementation.id, { logLocator: `session:${session.id}` });
      }).catch(() => {});
      if (transcriptPath === null && transcriptResolver) {
        void this.transcripts.captureSessionTranscript({ sessionId: harnessSessionId, sessionRowId: session.id, sessionLogDir: harness.sessionLogDir, transcriptResolver });
      }
    } catch {
    }
  }

  /** Resolve a Session's native transcript path on demand and persist it. */
  async ensureSessionTranscript(sessionRowId: number): Promise<string | null> {
    return this.transcripts.ensureSessionTranscript(sessionRowId);
  }

  private noteModelMismatch(
    task: TaskRow,
    usage: AttemptUsage | null,
    record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
  ): void {
    const observed = usage ? observedModelMismatch(task.model, usage.models) : null;
    if (observed) record('lifecycle', { event: 'model_mismatch', expected: task.model, observed });
  }

  /**
   * Boot-time healing: finished runs whose stored usage has no per-model split
   * get one more read of the (now settled) session log. Stored ACP totals win
   * over re-derived ones.
   */
  async backfillUsage(): Promise<void> {
    const config = this.getConfig();
    for (const run of await this.attempts.listUsageBackfillCandidates()) {
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
      } catch {
      }
    }
    await this.attempts.backfillCosts(async (attempt) => {
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
    } catch {
    }
  }
}
