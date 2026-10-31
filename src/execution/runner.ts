import type { TrackerRef } from '../tracker/adapter.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { mergeIntoBase } from './branch-merge.js';
import { repoKey, withBaseCheckoutLock, withRepoLock } from './repo-lock.js';
import { bestEffort, errorMessage, type FailureReport, type FireAndForget } from '../error-handling.js';
import { classifyGitFailure, type GitCircuitBreaker } from './git-failure.js';
import type { AttemptUsageSnapshot } from './usage.js';
import { LiveUsageTailer } from './live-usage-tailer.js';
import { UsageSampler } from './usage-sampler.js';
import { TranscriptCapture } from './transcript-capture.js';
import { ActiveRuns, type ActiveRun } from './active-runs.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import { driveFields } from './prompt-template.js';
import { PromptLibrary } from '../domain/prompt-library-store.js';
import { VerificationCoordinator, type VerificationCoordinatorDeps } from './verification-coordinator.js';
import { TurnDriver, type TurnDriverDeps } from './turn-driver.js';
import { EpicRefreshResolver, type EpicRefreshResolverDeps } from './epic-refresh-resolver.js';
import { WorkspaceProvisioner, type WorkspaceProvisionerDeps } from './workspace-provisioner.js';
import { RunControl, type RunControlDeps, type RunBoundaryResult } from './run-control.js';
import { UsageBackfiller, type UsageBackfillerDeps } from './usage-backfiller.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import { SessionStore } from '../domain/sessions.js';
import { resolveModelOption } from '../domain/model-options.js';
import type { ClassifierOutcome, WorkflowClassifierOutcome } from '../domain/route-classifier.js';
import { NO_CLASSIFIER, type WorkflowClassifierRecord } from '../domain/tasks.js';
import { DomainError, GitError } from '../domain/errors.js';
import { kubernetesTargetOf, kubernetesWorkflowRefusal, mixedWorkflowRefusal } from './workspace-execution-targets.js';
import { mergeRemoteTicketBranch } from './remote-merge.js';
import { AttemptStore, type AttemptGuardrailSnapshot } from '../domain/attempts.js';
import type { EscalationCause } from '../domain/task-routing.js';
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
import { parseCost, pricesForHarness, sumCosts } from '../domain/pricing.js';
import { isForeignKeyViolation } from '../db/errors.js';
import { logger } from '../logger.js';
import type { MergePolicyOutcome } from './merge-policy.js';
import type { EpicRefreshResolveDispatchOutcome, EpicRefreshResolveTarget } from './epic-coordinator.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { SpanContext } from '@opentelemetry/api';
import { startOperation } from '../telemetry/operations.js';
import { InFlight } from '../reliability/in-flight.js';
import { childExited } from './child-exit.js';
import { killProcessGroup } from './process-groups.js';
import { resolveBeforeClassifier, resolveTaskWorkflow, workflowInputOf } from '../domain/workflow-assignment.js';
import { resolveVars, workspaceVarsFor, type VarRecord } from '../domain/workflow-vars.js';
import { parseWorkflow } from '../domain/workflow.js';
import type { WorkflowChosen } from '../db/schema.js';
import { WorkflowEngine, parseWorkflowRef, type AgentDriveRequest, type AgentDriveResult, type EpicSubject } from './workflow-engine.js';
import { WorkflowLibrary } from '../domain/workflow-library-store.js';
import { seedLegacyResume } from './legacy-resume-seeding.js';
import { WorkflowStepRunStore } from '../domain/workflow-step-runs.js';
import { createPodOpener } from './pod-opener.js';
import { createChildProcessSpawn } from '../verification/command-verifier.js';

export type { LiveAttemptEvent } from './live-events.js';
export type { RunnerEvents, RunnerOptions, Workspace } from './runner-options.js';
import type { RunnerEvents, RunnerOptions } from './runner-options.js';

const LIFECYCLE_SETTLE_GRACE_MS = 15_000;

export class Runner {
  private readonly activeRuns = new ActiveRuns();
  private readonly mergeCoordinator: MergeCoordinator;
  private shuttingDown = false;
  private readonly drives = new InFlight();

  private readonly gitBreaker: GitCircuitBreaker | undefined;
  private readonly epicBaseNotReady: RunnerOptions['epicBaseNotReady'];
  private readonly events: RunnerEvents;
  private readonly worktreesDir: string;
  private readonly keys: RunnerOptions['keys'];
  private readonly autoDrive: AutoDrive | undefined;
  private readonly archive: RunnerOptions['archive'];
  private readonly promptLibrary: PromptLibrary;
  private readonly taskEvents: RunnerOptions['taskEvents'];
  private readonly getWorkspace: RunnerOptions['getWorkspace'];
  private readonly agentMessages: RunnerOptions['agentMessages'];
  private readonly postMerge: RunnerOptions['postMerge'];
  private readonly criticDrive: RunnerOptions['criticDrive'];
  private readonly routeClassifier: RunnerOptions['routeClassifier'];
  private readonly commandSpawn: RunnerOptions['commandSpawn'];
  private readonly spawnProcessGroup: RunnerOptions['spawnProcessGroup'];
  private readonly fireAndForget: FireAndForget;
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
  private readonly workflowEngine: WorkflowEngine;
  private readonly workflowLibrary: WorkflowLibrary;
  private readonly stepRuns: WorkflowStepRunStore;
  private readonly epicRefreshResolver: EpicRefreshResolver;
  private readonly workspaceProvisioner: WorkspaceProvisioner;
  readonly runControl: RunControl;
  private readonly usageBackfiller: UsageBackfiller;
  /** The MCP endpoint agents should call back to; set once the server listens. */
  mcpUrl: string | null = null;

  constructor(
    private readonly taskService: TaskService,
    private readonly asyncDb: AsyncDbHandle,
    private readonly getConfig: () => AppConfig,
    options: RunnerOptions,
  ) {
    this.events = options.events ?? {};
    this.worktreesDir = options.worktreesDir ?? join(tmpdir(), 'harmonic-worktrees');
    this.keys = options.keys;
    this.autoDrive = options.autoDrive;
    this.archive = options.archive;
    this.promptLibrary = options.promptLibrary ?? new PromptLibrary(null);
    this.taskEvents = options.taskEvents;
    this.getWorkspace = options.getWorkspace;
    this.agentMessages = options.agentMessages;
    this.postMerge = options.postMerge;
    this.gitBreaker = options.gitBreaker;
    this.epicBaseNotReady = options.epicBaseNotReady;
    this.criticDrive = options.criticDrive;
    this.routeClassifier = options.routeClassifier;
    this.commandSpawn = options.commandSpawn;
    this.spawnProcessGroup = options.spawnProcessGroup;
    this.fireAndForget = options.fireAndForget;
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
      this.fireAndForget,
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
      undefined,
      { onFailedAttemptRequeued: options.onFailedAttemptRequeued, onTaskMerged: options.onTaskMerged },
    );
    this.sessionRetirement = options.sessionRetirement;
    this.isGloballyPaused = options.isGloballyPaused;
    this.onGloballyPaused = options.onGloballyPaused;
    this.tailer = new LiveUsageTailer(
      {
        sample: (attemptId) => this.usage.sampleSnapshot(attemptId),
        emit: (attemptId, snapshot) => this.events.onAttemptUsage?.({ attemptId, snapshot }),
        persist: (attemptId, snapshot) => {
          this.fireAndForget(() => this.attempts.update(attemptId, { liveUsage: JSON.stringify(snapshot) }), {
            op: 'runner.persistLiveUsage',
            level: 'warn',
            context: { attemptId },
          });
        },
      },
      this.fireAndForget,
      options.tailerCadence,
    );
    this.mergeCoordinator = new MergeCoordinator(this.mergeCoordinatorDeps());
    this.epicRefreshResolver = new EpicRefreshResolver(this.epicRefreshResolverDeps());
    this.workspaceProvisioner = new WorkspaceProvisioner(this.workspaceProvisionerDeps());
    this.verification = new VerificationCoordinator(this.verificationCoordinatorDeps());
    this.turnDriver = new TurnDriver(this.turnDriverDeps());
    this.workflowLibrary = options.workflows?.library ?? new WorkflowLibrary(null);
    this.stepRuns = new WorkflowStepRunStore(this.asyncDb);
    this.workflowEngine = this.createWorkflowEngine(options.workflows);
    this.runControl = new RunControl(this.runControlDeps());
    this.usageBackfiller = new UsageBackfiller(this.usageBackfillerDeps());
  }

  private createWorkflowEngine(workflows: RunnerOptions['workflows']): WorkflowEngine {
    const secrets = workflows?.secrets;
    const workspaceName = workflows?.workspaceName;
    return new WorkflowEngine({
      library: this.workflowLibrary,
      stepRuns: this.stepRuns,
      spawn: this.commandSpawn ?? createChildProcessSpawn(this.spawnProcessGroup),
      secrets: async (task) => {
        if (task.workspaceId == null || !secrets) return {};
        const workspaceId = task.workspaceId;
        const entries = await Promise.all((await secrets.list(workspaceId)).map(async (secret) => [secret.name, await secrets.reveal(workspaceId, secret.name)] as const));
        return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
      },
      workspaceName: async (task) => (task.workspaceId == null || !workspaceName ? '' : workspaceName(task.workspaceId)),
      cwdFor: (task) => this.workspaceProvisioner.dispatchCwd(task),
      baseBranchFor: (task) => this.mergeCoordinator.resolveBaseBranch(task),
      mergeBranch: async (task, run) => {
        await this.attempts.update(run.id, await this.diffSnapshotFor(task, run.id));
        if (await this.runsOnKubernetes(task)) {
          const outcome = await mergeRemoteTicketBranch({ repoDir: task.workingDir, remote: 'origin', baseBranch: run.baseBranch!, taskBranch: run.branch! });
          return outcome.kind === 'merged'
            ? { ok: true, mode: 'cas', oid: outcome.mergeOid, baseBranch: run.baseBranch!, branch: run.branch! }
            : { ok: false, reason: outcome.reason === 'conflict' ? 'conflict' : 'stale-base', detail: outcome.message };
        }
        return withBaseCheckoutLock(task.workingDir, () =>
          withRepoLock(task.workingDir, async () =>
            mergeIntoBase({
              repoDir: task.workingDir,
              baseBranch: run.baseBranch!,
              branch: run.branch!,
              expectedOid: await Git.revParse(task.workingDir, run.branch!),
              mode: 'merge',
              noFastForward: true,
              mutexHeld: true,
            }),
          ),
        );
      },
      markTicketClosePending: async (task) => {
        await this.taskService.setTicketClosePending(task.id, true);
      },
      closeTicket: (task, comment) => this.autoDrive?.closeTicket(task, comment) ?? Promise.resolve(false),
      commentOnTicket: (task, body) => this.autoDrive?.commentOnTicket(task, body) ?? Promise.resolve(false),
      openPullRequest: (task, run) => this.autoDrive?.openPullRequest(task, run) ?? Promise.resolve(null),
      ...(workflows?.pods
        ? {
            pods: createPodOpener<TaskRow>({
              ...workflows.pods,
              baseBranchFor: (task) => this.mergeCoordinator.resolveBaseBranch(task),
              setExecution: async (task, execution) => {
                await this.taskService.setExecution(task.id, execution);
              },
            }),
          }
        : {}),
      escalate: async (task, run, reason) => this.settleEscalated(task, await this.attempts.get(run.id), reason, {}),
      complete: async (task, run) => this.settleAutoCompleted(task, await this.attempts.get(run.id), {}),
      onStepChanged: (owner) => ('taskId' in owner ? this.events.onStepChanged?.(owner.taskId) : this.events.onEpicMergeStep?.(owner)),
      boundary: async (task) => (await this.runControl.checkRunBoundary(task.id)).stop,
      agent: {
        drive: { run: (req) => (req.task && !req.pod ? this.turnDriver.runAgentTurn(req) : this.criticDrive.run(req)) },
        getConfig: this.getConfig,
        prompts: () => this.promptLibrary.enginePrompts(),
        route: (task) => this.taskService.routing.ticketRoute(task),
        resolveOption: async (task, code) => resolveModelOption(code, { ticketOverrides: task.modelOptionOverrides, workspace: { modelOptions: (await this.getWorkspace?.(task.workspaceId))?.modelOptions ?? null }, config: this.getConfig() }),
        resolvePrompt: (text) => this.promptLibrary.resolve(text),
        promptFields: (task) => (this.autoDrive ? this.autoDrive.promptFields(task) : Promise.resolve(driveFields(task, this.urlFor))),
      },
    });
  }

  private mergeCoordinatorDeps(): MergeCoordinatorDeps {
    return {
      getConfig: this.getConfig,
      prompts: () => this.promptLibrary.enginePrompts(),
      attempts: this.attempts,
      epicMergeEvents: new EpicMergeEventStore(this.asyncDb),
      criticDrive: this.criticDrive,
      archive: this.archive,
      onAttemptEvent: (event) => this.events.onAttemptEvent?.(event),
      getWorkspace: this.getWorkspace,
      postMerge: this.postMerge,
      listWorkingTasks: () => this.taskService.list({ state: 'working' }),
      routing: this.taskService.routing,
      onEpicMergeStep: (payload) => this.events.onEpicMergeStep?.(payload),
    };
  }

  private epicRefreshResolverDeps(): EpicRefreshResolverDeps {
    return {
      routing: this.taskService.routing,
      attempts: this.attempts,
      archive: this.archive,
      epicMergeEvents: new EpicMergeEventStore(this.asyncDb),
      onAttemptEvent: (event) => this.events.onAttemptEvent?.(event),
      getConfig: this.getConfig,
      prompts: () => this.promptLibrary.enginePrompts(),
      getWorkspace: this.getWorkspace,
      worktreesDir: this.worktreesDir,
      criticDrive: this.criticDrive,
      fireAndForget: this.fireAndForget,
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
      spawnProcessGroup: this.spawnProcessGroup,
    };
  }

  private verificationCoordinatorDeps(): VerificationCoordinatorDeps {
    return {
      attempts: this.attempts,
      sessionStore: this.sessionStore,
      activeRuns: this.activeRuns,
      archive: this.archive,
      events: this.events,
      criticDrive: this.criticDrive,
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
      prompts: () => this.promptLibrary.enginePrompts(),
      activeRuns: this.activeRuns,
      sessionContinuation: this.sessionContinuation,
      archive: this.archive,
      events: this.events,
      autoDrive: this.autoDrive,
      keys: this.keys,
      fireAndForget: this.fireAndForget,
      getWorkspace: this.getWorkspace,
      agentMessages: this.agentMessages,
      gitBreaker: this.gitBreaker,
      onGloballyPaused: this.onGloballyPaused,
      spendPollMs: this.spendPollMs,
      spendGraceMs: this.spendGraceMs,
      mcpUrl: () => this.mcpUrl,
      isShuttingDown: () => this.shuttingDown,
      prepareWorkspace: (task, run, resume) => this.workspaceProvisioner.prepareWorkspace(task, run, resume),
      finalizeWorkspace: (task, run, attemptNumber, workspace) => this.workspaceProvisioner.finalizeWorkspace(task, run, attemptNumber, workspace),
      spawnHarness: (task, harness, cwd, extraEnv, unattended) => this.workspaceProvisioner.spawnHarness(task, harness, cwd, extraEnv, unattended),
      checkRunBoundary: (taskId) => this.checkRunBoundary(taskId),
      latestAttemptFor: (task) => this.latestAttemptFor(task),
      recordRunEvent: (task, run, type, payload) => this.recordRunEvent(task, run, type, payload),
      coordinateSettle: (task, run, type, projection, patch) => this.coordinateSettle(task, run, type, projection, patch),
      settleEscalated: (task, run, reason, patch) => this.settleEscalated(task, run, reason, patch),
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
      prompts: () => this.promptLibrary.enginePrompts(),
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

  trackBackground(op: () => Promise<unknown>, report: FailureReport): void {
    this.fireAndForget(op, report);
  }

  worktreePathForTask(task: TaskRow): string {
    return this.workspaceProvisioner.worktreePathForTask(task);
  }

  hasLiveAgent(taskId: number): boolean {
    return this.activeRuns.hasTask(taskId);
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
  async resumeWithGuidance(task: TaskRow, guidance: string, options: { startNow: boolean; reuseSession: boolean }): Promise<void> {
    const { startNow, reuseSession } = options;
    await this.repinWorkflow(task);
    const trimmed = guidance.trim();
    if (!trimmed && !startNow) {
      await this.taskService.requeue(task.id);
      return;
    }
    const attempts = await this.attempts.listForTask(task.id);
    const run = attempts.at(-1);
    const escalated = attempts.findLast((attempt) => attempt.state === 'escalated');
    if (escalated && trimmed) await this.attempts.setFeedback(escalated.id, trimmed);
    const choice = startNow ? (reuseSession ? 'full' : 'condensed') : undefined;
    await this.taskService.requeue(task.id, trimmed, choice);
    if (startNow) {
      if (run && reuseSession) {
        this.activeRuns.setPendingContinuation(
          task.id,
          await this.sessionContinuation.decideContinuation(task, run, await this.getWorkspace?.(task.workspaceId)),
        );
      }
      await this.start(task.id);
    }
  }

  /** Operator Accept (ADR-0038): overrides the failed workflow step and resumes the workflow after it on the same Attempt. */
  async acceptWorkflowStep(task: TaskRow, run: AttemptRow): Promise<void> {
    const pinned = await this.workflowTaskFor(task);
    await seedLegacyResume({ library: this.workflowLibrary, stepRuns: this.stepRuns, attempts: this.attempts }, pinned, await this.attempts.get(run.id), true);
    await this.workflowEngine.acceptFailed(pinned);
    const working = await this.taskService.setState(task.id, 'working');
    await this.beginRun(working, undefined, await this.attempts.get(run.id));
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
    if (task.workflowRef !== null && run) {
      const engine = this.workflowEngine;
      await bestEffort(async () => engine.close(task, await this.attempts.get(run.id)), { op: 'runner.workflow.closeCleanup', level: 'warn', context: { taskId: task.id, attemptId: run.id } });
    }
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

  private async beginRun(requested: TaskRow, parent?: SpanContext, resumedAttempt?: AttemptRow): Promise<AttemptRow> {
    // Covers the pre-spawn/between-turns gaps too, so a steer can't mistake a healthy Task for stranded.
    this.activeRuns.markDriving(requested.id);
    try {
      const baseGate = (await this.epicBaseNotReady?.(requested)) ?? 'ready';
      switch (baseGate) {
        case 'stale':
          throw new DomainError(
            'invalid_state',
            `task ${requested.id} is an Epic member whose integration branch (${requested.baseBranch}) is behind its base; ` +
              'it is refreshed when the blocking Epic is integrated — retry shortly',
          );
        case 'missing':
          throw new DomainError(
            'invalid_state',
            `task ${requested.id} is an Epic member whose integration branch (${requested.baseBranch ?? 'unassigned'}) is not ready yet; ` +
              'it is cut/re-cut on the next tracker poll — retry shortly',
          );
        case 'ready':
          break;
        default:
          baseGate satisfies never;
      }
      const pinned = await this.workflowTaskFor(requested);
      const resumed = resumedAttempt ?? (await this.interruptedAttempt(pinned));
      const task: TaskRow = resumed?.harness ? { ...pinned, harness: resumed.harness, model: resumed.model ?? pinned.model } : pinned;
      return await this.beginWorkflowRun(task, parent, resumed);
    } catch (err) {
      this.activeRuns.clearDriving(requested.id);
      throw err;
    }
  }

  private async runsOnKubernetes(task: TaskRow): Promise<boolean> {
    if (task.workflowRef === null) return false;
    const { name, version } = parseWorkflowRef(task.workflowRef);
    const { text } = await this.workflowLibrary.getVersion(name, version);
    return kubernetesTargetOf({ list: () => [{ name, text }] }, name) !== undefined;
  }

  /** The latest Attempt when a restart interrupted it: its workflow resumes rather than starting over. */
  private async interruptedAttempt(task: TaskRow): Promise<AttemptRow | undefined> {
    const latest = (await this.attempts.listForTask(task.id)).at(-1);
    return latest?.state === 'failed' && latest.reason === 'process-death' ? latest : undefined;
  }

  private async assignWorkflow(task: TaskRow): Promise<{ ref: string; chosen: WorkflowChosen; label: string | null; vars: VarRecord; classifier: WorkflowClassifierRecord }> {
    const library = this.workflowLibrary;
    const entries = library.list();
    const names = new Set(entries.filter((entry) => entry.subject === 'ticket').map((entry) => entry.name));
    const workspace = (await this.getWorkspace?.(task.workspaceId)) ?? null;
    const config = this.getConfig();
    const exists = (name: string) => names.has(name);
    let classifier = NO_CLASSIFIER;
    let classified: { name: string; reason: string } | null = null;
    if (resolveBeforeClassifier(workflowInputOf(task, workspace, config, exists)) === null) {
      const outcome = await this.classifyWorkflow(task, entries);
      if (outcome) {
        classifier = {
          reason: outcome.reason,
          routingUsage: outcome.routing ? JSON.stringify(outcome.routing.usage) : null,
          routingCost: outcome.routing?.cost ? JSON.stringify(outcome.routing.cost) : null,
        };
        if (outcome.kind === 'chosen') classified = { name: outcome.name, reason: outcome.reason };
      }
    }
    classifier = this.withEarlierSpend(task, classifier);
    const assignment = resolveTaskWorkflow(task, workspace, config, exists, classified);
    const refusal = kubernetesWorkflowRefusal(library, assignment.name, task.isolationMode as 'direct' | 'worktree');
    if (refusal) throw new DomainError('validation', refusal);
    if (workspace) {
      const mixedRefusal = await mixedWorkflowRefusal(library, assignment.name, { name: workspace.name ?? `#${task.workspaceId}`, workingDir: workspace.workingDir ?? task.workingDir, codeRepository: workspace.codeRepository ?? null });
      if (mixedRefusal) throw new DomainError('validation', mixedRefusal);
    }
    const version = library.get(assignment.name).version;
    const defaults = parseWorkflow((await library.getVersion(assignment.name, version)).text).vars;
    const vars = resolveVars(defaults, workspaceVarsFor(workspace, assignment.name), task.workflowVarOverrides);
    return { ref: `${assignment.name}@${version}`, chosen: assignment.chosen, label: assignment.label ?? null, vars, classifier };
  }

  /** A Retry's classifier call adds to the routing spend already on the Ticket instead of replacing it. */
  private withEarlierSpend(task: TaskRow, now: WorkflowClassifierRecord): WorkflowClassifierRecord {
    if (task.workflowRoutingUsage === null) return now;
    const total = sumCosts([parseCost(task.workflowRoutingCost), parseCost(now.routingCost)]);
    return { reason: now.reason, routingUsage: now.routingUsage ?? task.workflowRoutingUsage, routingCost: total ? JSON.stringify(total) : null };
  }

  /** Runs the workflow classifier when it is on for this Ticket's Workspace; never throws, since it is advisory. */
  private async classifyWorkflow(task: TaskRow, entries: ReadonlyArray<{ name: string; description: string }>): Promise<WorkflowClassifierOutcome | null> {
    const classifier = this.routeClassifier;
    if (!classifier) return null;
    let outcome: WorkflowClassifierOutcome;
    try {
      const workspace = await this.taskService.routing.workflowClassifierWorkspace(task);
      if (!workspace) return null;
      outcome = await classifier.classifyWorkflow({
        workspace,
        title: task.trackerTitle ?? task.prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? `Task ${task.id}`,
        description: task.prompt,
        labels: task.trackerLabels ?? [],
        workflows: entries.map(({ name, description }) => ({ name, description })),
      });
    } catch (error) {
      outcome = { kind: 'abstained', reason: errorMessage(error), routing: null };
    }
    await bestEffort(async () => {
      await this.taskEvents?.appendEvent(task.id, outcome.kind === 'chosen'
        ? { event: 'workflow-classified', workflow: outcome.name, reason: outcome.reason, prompt: outcome.prompt }
        : { event: 'workflow-classifier-abstained', message: `Workflow classifier abstained: ${outcome.reason}`, reason: outcome.reason, ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }) });
      this.events.onTaskEvent?.(task.id);
    }, { op: 'runner.assignWorkflow.recordClassification', level: 'warn', context: { taskId: task.id } });
    return outcome;
  }

  private async workflowTaskFor(task: TaskRow): Promise<TaskRow> {
    if (task.workflowRef !== null) return task;
    const assigned = await this.assignWorkflow(task);
    return this.taskService.pinWorkflow(task.id, assigned.ref, assigned.chosen, assigned.label, assigned.vars, assigned.classifier);
  }

  private async repinWorkflow(task: TaskRow): Promise<void> {
    if (task.workflowRef === null) return;
    const assigned = await this.assignWorkflow(task);
    if (assigned.ref !== task.workflowRef || assigned.chosen !== task.workflowChosen || assigned.label !== task.workflowLabel || assigned.classifier.reason !== task.workflowReason || assigned.classifier.routingCost !== task.workflowRoutingCost || JSON.stringify(assigned.vars) !== JSON.stringify(task.workflowVars)) await this.taskService.repinWorkflow(task.id, assigned.ref, assigned.chosen, assigned.label, assigned.vars, assigned.classifier);
  }

  private async beginWorkflowRun(requested: TaskRow, parent: SpanContext | undefined, resumedAttempt: AttemptRow | undefined): Promise<AttemptRow> {
    let task = requested;
    let created: AttemptRow | undefined;
    try {
      let classification: ClassifierOutcome | null = null;
      if (!resumedAttempt) {
        classification = await this.classifyRoute(task);
        if (classification?.kind === 'chosen') task = { ...task, harness: classification.option.harness, model: classification.option.model };
      }
      const route = await this.taskService.routing.ticketRoute(task);
      if (!route.ok) {
        const unspawned = await this.attempts.create(task.id);
        await this.settleEscalated(task, unspawned, route.reason, {}, route.cause);
        this.activeRuns.clearDriving(task.id);
        return unspawned;
      }
      const ws = (await this.getWorkspace?.(task.workspaceId)) ?? { guardrailBudget: null, guardrailProgress: null, toolTimeoutMinutes: null };
      const snapshot: AttemptGuardrailSnapshot = {
        guardrailConfig: resolveGuardrails(ws, this.getConfig()),
        priceTable: pricesForHarness(route.config),
      };
      created = resumedAttempt
        ? await this.attempts.update(resumedAttempt.id, {
            state: 'running',
            startedAt: Date.now(),
            endedAt: null,
            reason: null,
            detail: null,
            guardrailConfig: JSON.stringify(snapshot.guardrailConfig),
            priceTable: JSON.stringify(snapshot.priceTable),
            harness: task.harness,
            model: task.model,
            ...(task.continuationChoice === 'condensed' ? { sessionRowId: null, sessionId: null } : {}),
          })
        : await this.attempts.create(task.id, { guardrails: snapshot, route: { harness: task.harness, model: task.model } });
      const pendingContinuation = this.activeRuns.takePendingContinuation(task.id);
      if (pendingContinuation !== undefined) await this.attempts.setContinuation(created.id, pendingContinuation);
      const bound = await this.sessionContinuation.bindContinuationIfEligible(task, created);
      if (!resumedAttempt) {
        if (classification) await this.recordClassification(task, bound, classification);
        await this.recordRouteChange(task, bound);
      }
      if ((await this.checkRunBoundary(task.id)).stop) {
        this.activeRuns.clearDriving(task.id);
        return bound;
      }
      if (resumedAttempt) await seedLegacyResume({ library: this.workflowLibrary, stepRuns: this.stepRuns, attempts: this.attempts }, task, bound, false);
      const operation = this.startRunOperation(task, bound, parent);
      if (!(await this.prepareRunWorkspace(task, bound))) {
        this.activeRuns.clearDriving(task.id);
        return await this.attempts.get(bound.id);
      }
      const run = await this.attempts.get(bound.id);
      this.driveWorkflow(task, run, operation, resumedAttempt !== undefined);
      return run;
    } catch (err) {
      if (created) {
        const attemptId = created.id;
        await bestEffort(async () => {
          if ((await this.attempts.get(attemptId)).state !== 'running') return;
          await this.attempts.update(attemptId, { state: 'failed', endedAt: Date.now(), reason: 'failed', detail: errorMessage(err) });
        }, { op: 'runner.beginRun.failAttempt', level: 'warn', context: { taskId: task.id, attemptId } });
      }
      throw err;
    }
  }

  /** Prepares the Attempt's workspace; a refusal settles the Attempt (back to `ready` when transient, escalated when not) and returns false. */
  private async prepareRunWorkspace(task: TaskRow, run: AttemptRow): Promise<boolean> {
    try {
      await this.workspaceProvisioner.prepareWorkspace(task, run);
      this.gitBreaker?.recordSuccess(repoKey(task.workingDir));
      return true;
    } catch (err) {
      if (err instanceof EpicBaseNotReady) {
        await this.coordinateSettle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: err.reason });
      } else if (err instanceof BaseBranchUnresolved) {
        await this.settleEscalated(task, run, err.reason, {});
      } else if (err instanceof GitError) {
        const cls = classifyGitFailure([err.stderr, err.message].filter(Boolean).join('\n'));
        const failure = this.gitBreaker?.recordFailure(repoKey(task.workingDir));
        if (cls === 'permanent' || failure?.opened) await this.settleEscalated(task, run, `git workspace preparation failed (${cls}): ${err.message}`, {});
        else await this.coordinateSettle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: err.message });
      } else {
        throw err;
      }
      return false;
    }
  }

  private startRunOperation(task: TaskRow, run: AttemptRow, parent: SpanContext | undefined): ReturnType<typeof startOperation> {
    const operation = startOperation({
      type: 'attempt',
      parent,
      attributes: {
        'task.id': task.id,
        'task.title': task.trackerTitle ?? task.prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? `Task ${task.id}`,
        'attempt.id': run.id,
        'task.origin': task.origin,
        ...(task.workspaceId == null ? {} : { 'workspace.id': task.workspaceId }),
      },
    });
    this.activeRuns.setOperation(run.id, operation);
    return operation;
  }

  private driveWorkflow(task: TaskRow, run: AttemptRow, operation: ReturnType<typeof startOperation>, resumed: boolean): void {
    this.drives.add(operation.run(async () => {
      try {
        await this.workflowEngine.run(task, run, resumed, task.continuationChoice !== 'condensed' && (resumed || run.sessionId != null));
        await this.finishRunOperation(run.id);
      } catch (error) {
        operation.fail(errorMessage(error));
        this.activeRuns.deleteOperation(run.id);
        logger.error(`task ${task.id} attempt ${run.id}: workflow engine crashed: ${errorMessage(error)}`);
        await bestEffort(async () => {
          const current = await this.attempts.get(run.id);
          if (current.state !== 'running') return;
          await this.settleEscalated(task, current, `workflow engine crashed: ${errorMessage(error)}`, {});
        }, { op: 'runner.workflow.settleCrashed', level: 'warn', context: { taskId: task.id, attemptId: run.id } });
      } finally {
        this.activeRuns.clearDriving(task.id);
        const leftoverSeed = this.activeRuns.takePendingOperatorSeed(task.id);
        if (leftoverSeed !== undefined) await this.redeliverOrphanedSteer(task.id, leftoverSeed);
      }
    }), 'runner.drive');
  }

  /** Runs the Route Classifier when it decides this Ticket's route; never throws, since the classifier is advisory. */
  private async classifyRoute(task: TaskRow): Promise<ClassifierOutcome | null> {
    const classifier = this.routeClassifier;
    if (!classifier) return null;
    try {
      const workspace = await this.taskService.routing.classifierWorkspace(task);
      if (!workspace) return null;
      const previous = (await this.attempts.listForTask(task.id)).findLast((a) => a.state !== 'running');
      return await classifier.classify({
        workspace,
        title: task.trackerTitle ?? task.prompt.split('\n').find((line) => line.trim().length > 0)?.trim() ?? `Task ${task.id}`,
        description: task.prompt,
        labels: task.trackerLabels ?? [],
        attemptNumber: (previous?.number ?? 0) + 1,
        previousVerdict: previous ? (previous.reason ?? previous.state) : undefined,
        previousFailureReason: previous ? (previous.detail ?? previous.feedback ?? undefined) : undefined,
        modelOptionOverrides: task.modelOptionOverrides,
      });
    } catch (error) {
      return { kind: 'abstained', reason: errorMessage(error), routing: null };
    }
  }

  private async recordClassification(task: TaskRow, bound: AttemptRow, outcome: ClassifierOutcome): Promise<void> {
    await bestEffort(async () => {
      await this.attempts.update(bound.id, {
        routeKind: outcome.kind === 'chosen' ? 'classifier' : 'abstained',
        routeOption: outcome.kind === 'chosen' ? outcome.option.id : null,
        routeReason: outcome.reason,
        routeOptionPosition: outcome.kind === 'chosen' ? outcome.position : null,
        routeOptionCount: outcome.kind === 'chosen' ? outcome.optionCount : null,
        ...(outcome.routing
          ? {
              routingUsage: JSON.stringify(outcome.routing.usage),
              routingCost: outcome.routing.cost ? JSON.stringify(outcome.routing.cost) : null,
            }
          : {}),
      });
      const archived = outcome.prompt === undefined ? null : await this.archive?.appendRoutingPrompt(task, bound.number, outcome.prompt);
      const promptRef = archived ? { locator: archived.locator, promptIndex: archived.promptIndex } : {};
      const payload =
        outcome.kind === 'chosen'
          ? { ...promptRef, event: 'route-classified', optionId: outcome.option.id, harness: outcome.option.harness, model: outcome.option.model, reason: outcome.reason }
          : { ...promptRef, event: 'route-classifier-abstained', message: `Route Classifier abstained: ${outcome.reason}`, reason: outcome.reason };
      const persisted = await this.attempts.appendEvent(bound.id, { type: 'lifecycle', payload });
      this.events.onAttemptEvent?.(persisted);
    }, { op: 'runner.beginRun.recordClassification', level: 'warn', context: { attemptId: bound.id } });
  }

  private async recordRouteChange(task: TaskRow, bound: AttemptRow): Promise<void> {
    await bestEffort(async () => {
      const prior = (await this.attempts.listForTask(task.id)).findLast((a) => a.id !== bound.id && a.harness);
      if (!prior?.harness || (prior.harness === task.harness && prior.model === task.model)) return;
      const route = await this.taskService.routing.routingFor(task.id);
      const payload = {
        event: 'route-changed',
        from: { harness: prior.harness, model: prior.model },
        to: { harness: task.harness, model: task.model },
        label: route?.applied ? route.label : null,
        sessionKept: bound.sessionRowId !== null,
      };
      const persisted = await this.attempts.appendEvent(bound.id, { type: 'lifecycle', payload });
      this.events.onAttemptEvent?.(persisted);
    }, { op: 'runner.beginRun.recordRouteChange', level: 'warn', context: { taskId: task.id, attemptId: bound.id } });
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

  /** The agent-driven finish signal (`finish_task` MCP tool): ends the active turn. Returns whether an active Attempt was found. */
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

  private async checkRunBoundary(taskId: number): Promise<RunBoundaryResult> {
    return this.runControl.checkRunBoundary(taskId);
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

  /** Tries the same chain as the steer route for a seed left over when its drive loop settled; else records it undelivered. */
  private async redeliverOrphanedSteer(taskId: number, text: string): Promise<void> {
    const delivered =
      (await this.steer(taskId, text)) ||
      (await this.steerSettled(taskId, text)) ||
      (await this.steerPaused(taskId, text)) ||
      (await this.steerWorking(taskId, text));
    if (delivered) return;
    logger.warn('Steer could not be redelivered after its drive loop settled', { taskId });
    const run = await this.attempts.getRunningForTask(taskId);
    const attemptId = run?.id ?? (await this.attempts.listForTask(taskId)).at(-1)?.id;
    if (attemptId === undefined) return;
    const event = await this.attempts.appendEvent(attemptId, { type: 'lifecycle', payload: { event: 'steer_undelivered', text } });
    this.events.onAttemptEvent?.(event);
  }

  private forActiveTask(taskId: number, fn: (active: ActiveRun) => void): boolean {
    const active = this.activeRuns.forTask(taskId);
    if (!active) return false;
    fn(active);
    return true;
  }

  /** Process shutdown: kill every active harness, then wait for each to exit and its Attempt drive to finish its final writes. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const teardown: Array<Promise<void>> = [];
    for (const active of this.activeRuns.values()) {
      active.verifyAbort.abort();
      this.kill(active);
      teardown.push(childExited(active.child), this.tailer.stop(active.attemptId));
    }
    await Promise.allSettled(teardown);
    await this.drives.drain();
    this.activeRuns.clear();
    this.usage.clearReaders();
  }

  /** Run the corrective turn for a failed whole-Epic verification in a checked-out integration worktree. */
  async runEpicAgentTurn(req: AgentDriveRequest<EpicSubject>): Promise<AgentDriveResult> {
    return this.verification.runEpicAgentTurn(req);
  }

  /** @see {@link EpicRefreshResolver.enqueueEpicRefreshResolution} */
  async enqueueEpicRefreshResolution(
    target: EpicRefreshResolveTarget,
    detail: string,
    escalate: (epicRef: TrackerRef, reason: string) => void | Promise<void>,
    retry: () => Promise<unknown>,
  ): Promise<EpicRefreshResolveDispatchOutcome> {
    return this.epicRefreshResolver.enqueueEpicRefreshResolution(target, detail, escalate, retry);
  }

  /** @see {@link MergeCoordinator.mergeEpicIntegration} */
  async mergeEpicIntegration(input: EpicIntegrationMergeInput): Promise<MergePolicyOutcome> {
    return this.mergeCoordinator.mergeEpicIntegration(input);
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
    if (patch.stat === undefined && run.diffHeadOid == null && run.branch && run.baseBranch) {
      patch = { ...patch, ...(await this.diffSnapshotFor(task, run.id)) };
    }
    await this.settleCoordinator.settle(task, run, type, projection, patch);
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

  private async settleEscalated(task: TaskRow, run: AttemptRow, reason: string, patch: Partial<AttemptRow>, cause?: EscalationCause): Promise<void> {
    await this.coordinateSettle(task, run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: `escalated to human: ${reason}`,
      ...(cause ? { cause } : {}),
    }, patch);
  }

  private kill(active: ActiveRun): void {
    killProcessGroup(active.child);
  }
}
