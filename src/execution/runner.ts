import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, GitError } from './git.js';
import { classifyGitFailure, type GitCircuitBreaker } from './git-failure.js';
import { adapterFor, adapterVersion, wholeFileReader, type SessionTailReader } from './harness/adapter.js';
import { collectUsage, collectUsageWithRetry, observedModelMismatch, activityLine, agentsFromTree, toolCallName, totalTokensOf, type RunUsage, type RunUsageSnapshot, type ParsedSession } from './usage.js';
import { LiveUsageTailer, type TailerCadence } from './live-usage-tailer.js';
import { codeIndexRepoGuidance, driveFields, promptForTask } from './prompt-template.js';
import { indexWorktree, dropIndexForPath } from './code-index.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, RunRow, WorkspaceRow, SessionRow } from '../db/schema.js';
import { AcpDriver, type AcpInitializeResult } from '../acp/driver.js';
import { SessionStore } from '../domain/sessions.js';
import { assessResumeEligibility, sessionFacts, type ResumeEnvironment } from '../domain/session-resume.js';
import {
  planSessionContinuation,
  sessionWarmthFacts,
  decideAttemptContinuation,
  HARNESS_SESSION_WARM_WINDOWS_MS,
  type ContinuationTrigger,
  type DeterministicContinuation,
} from '../domain/session-continuation.js';
import { repoKey } from './repo-lock.js';
import { DomainError } from '../domain/errors.js';
import type { RunStore, PersistedRunEvent, RunGuardrailSnapshot } from '../domain/runs.js';
import { RunFactStore } from '../domain/run-facts.js';
import { AttemptStore } from '../domain/attempts.js';
import { MergeJournalStore } from '../domain/merge-journal.js';
import type { SettleProjection } from '../domain/run-coordinator.js';
import { RunSettleCoordinator } from '../domain/run-settle.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import type { RunPhase } from '../domain/run-phases.js';
import type { RunFactType } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveGuardrails, resolveVerifiers, type ResolvedGuardrails } from '../domain/setting-override.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import {
  wallClockBudgetMs,
  wallClockTrip,
  formatBudgetReason,
  formatUnmeasurableReason,
  countsTowardExecutionBudget,
  spendTrip,
  toMicroUsd,
} from '../domain/guardrail-budget.js';
import { ExecutionChainStore } from '../domain/execution-chain-store.js';
import { sumPriorSpend, chainObserved, combineSpendOutcomes, type ChainSpend } from '../domain/execution-chain.js';
import { detectStall } from '../domain/stall-detector.js';
import { toProgressEvents, formatProgressReason } from '../domain/guardrail-progress.js';
import type { ProgressEvent } from '../domain/stall-detector.js';
import {
  toolTimeoutBudgetMs,
  toolTimeoutTrip,
  formatToolTimeoutReason,
} from '../domain/guardrail-tool-timeout.js';
import { TurnQueueStore } from '../domain/turn-queue-store.js';
import { runCommandVerifier, commandAttemptToInput } from '../verification/command-verifier.js';
import { createAcpCriticDrive, runCritic, criticAttemptToInput, type CriticHarnessDrive } from '../verification/critic.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import { resolvePrices, costOfUsages, type PriceTable } from './pricing.js';
import { workContextKey } from '../domain/work-context-key.js';
import { isForeignKeyViolation, type WorkContextLeaseStore } from '../domain/work-context-leases.js';
import { logger } from '../logger.js';
import { mergeIntoBaseAndRunPostMerge, type PostMergeHook } from './branch-merge.js';
import { singleFlight } from '../reliability/single-flight.js';
import { integrationBranchName, parseIntegrationBranch } from './epic-integration.js';
import type {
  EpicRefreshResolveDispatchOutcome,
  EpicRefreshTarget,
} from './epic-refresh-coordinator.js';
import type { MergeTrainCoordinator, MergeTrainMember, MergeTrainOutcome } from './merge-train-coordinator.js';
import type { AsyncDbHandle } from '../db/async.js';
import type { SpanContext } from '@opentelemetry/api';
import { startOperation, type Operation } from '../telemetry/operations.js';

/** How much harness stderr to keep for a failure reason — the tail, since
 * the fatal message is last. Bounds an otherwise unbounded buffer. */
const STDERR_TAIL_CAP = 8000;

/** The single nudge the progress Guardrail delivers through the steer channel
 * on a first detected stall (issue #131, ADR-0019) before it trips. A plain
 * course-correction prompt — one turn, no back-and-forth. */
const PROGRESS_NUDGE_TEXT =
  'You appear to be repeating the same step without making progress. Stop, re-read the task and the most ' +
  'recent error or result, and try a genuinely different approach — or finish if the work is already done.';

/** ACP session modes an afk Run tries, in order: Claude's 'auto' classifier
 * (asks only on risky tools) first, then 'bypassPermissions' (no callback) for
 * harnesses without 'auto'. Set via session/set_mode after the handshake. */
const AFK_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;

/** Harnesses that advertise no {@link AFK_PERMISSION_MODES} mode and gate
 * permissions per action (Codex `approval_policy: on-request`). Under afk these
 * are put into their {@link AFK_FULL_ACCESS_MODES} mode when they advertise one;
 * a harness that advertises none instead falls back to the per-request handler.
 * (Held-request + Permission-Rule approval for Runs is planned per ADR-0007; until
 * then a fallback request Escalates like every other afk Run.) */
const AFK_REQUEST_GATED_HARNESSES = ['codex'] as const;
const afkRequestGated = (harness: string): boolean => (AFK_REQUEST_GATED_HARNESSES as readonly string[]).includes(harness);

/** For a request-gated harness, the ACP session mode **id** that grants
 * unattended full access (no per-action approval) — Codex's `agent-full-access`
 * mode (its `approvalPolicy: never`, sandbox `danger-full-access`). Forced under
 * afk when {@link AFK_PERMISSION_MODES} offers nothing, so the Run runs
 * unattended (matching Claude's `auto`/`bypassPermissions`) instead of Escalating
 * on the first privileged tool. Codex's `approval_policy`/command-line YOLO flags
 * do not take effect over ACP — a `session/set_mode` to this id is the only
 * mechanism that does. NB the id is `agent-full-access`, not the sandbox-policy
 * name `danger-full-access` (codex-acp `_AgentMode.AgentFullAccess`). */
const AFK_FULL_ACCESS_MODES: Partial<Record<string, string>> = { codex: 'agent-full-access' };
const afkFullAccessMode = (harness: string, available: readonly string[]): string | undefined => {
  const mode = AFK_FULL_ACCESS_MODES[harness];
  return mode && available.includes(mode) ? mode : undefined;
};

/**
 * Default review SLA (issue #114): how long a native Run may sit parked in
 * `phase:'review'` awaiting a human accept/reject before the review-SLA sweep
 * settles it to a terminal disposition. The coordination spine ships no
 * operator-facing config (reliability-design §0, "the spine is infrastructure";
 * a per-Workspace review SLA is Unit A's setting), so the deadline is this
 * internal default until that merges. Seven days: long enough that a real review
 * queue never trips it, short enough that an abandoned review can't wedge a Work
 * Context lease forever. */
const LIVE_RUN_LOG_EVENT_ID_OFFSET = 1_000_000_000;

export interface RunnerEvents {
  /** Fired after every run event is persisted (live streaming hook). */
  onRunEvent?: (event: PersistedRunEvent) => void;
  /** ACP session updates are transient: streamed to clients, never persisted. */
  onRunLogEvent?: (event: LiveRunEvent) => void;
  /** Fired whenever a run reaches a terminal state. */
  onRunFinished?: (run: RunRow) => void;
  /** Fired ~1s while a run tails its native log (ADR 0010: `run_usage`). */
  onRunUsage?: (payload: { runId: number; snapshot: RunUsageSnapshot }) => void;
}

/** A live ACP update, with a Run-local monotonic id for reconnect de-duplication. */
export interface LiveRunEvent {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: { sessionUpdate: string; [key: string]: unknown };
}

export interface RunnerOptions {
  events?: RunnerEvents;
  /** Where temporary worktrees live; per-run subdirectories. */
  worktreesDir?: string;
  /** Mints/revokes the per-run scoped API key injected into the harness. */
  keys?: {
    mint: (runId: number) => Promise<string>;
    revoke: (runId: number) => void | Promise<void>;
  };
  /** Auto-drive collaborator for mirrored Tasks (issue #33); absent on a native-only server. */
  autoDrive?: AutoDrive;
  /** Resolves a Task's ticket URL for the critic's `{url}` interpolation token
   * (`drive-prompt.ts` `driveFields`). Independent of `autoDrive` because the
   * critic runs on native Runs too; absent → `{url}` resolves to empty. */
  urlFor?: (task: TaskRow) => string | null;
  /** Push/persist cadence for the live-usage tailer; defaults to ~1s/~10s. */
  tailerCadence?: TailerCadence;
  /** Spend-Guardrail poll + unmeasurable-grace cadence (issue #128); defaults to ~1s poll / 60s grace. */
  spendGuardrail?: { pollMs?: number; graceMs?: number } | undefined;
  /** Work Context lease heartbeat cadence (issue #122); defaults to ~30s. */
  leaseHeartbeat?: { intervalMs?: number } | undefined;
  /** Resolves a Task's Workspace row for the Guardrail snapshot (issue #126);
   * absent → the snapshot resolves against global defaults only. */
  getWorkspace?: (
    workspaceId: number | null,
  ) => Promise<
    | (Pick<
        WorkspaceRow,
        | 'guardrailBudget'
        | 'guardrailProgress'
        | 'verificationCommand'
        | 'verificationCritic'
        | 'maxAttempts'
        | 'contextReuseTokenLimit'
      > &
        Partial<Pick<WorkspaceRow, 'workingDir'>>)
    | undefined
  >;
  /** Injectable agent-critic drive (issue #164): the seam `runCritic` speaks an
   * ACP turn over. Absent → the real drive (`createAcpCriticDrive`) spawns the
   * builder's configured harness as a contained read-only reviewer; tests
   * substitute a fake returning a canned verdict without spawning a process. */
  criticDrive?: CriticHarnessDrive | undefined;
  /** Session retirement hook (issue #148): every terminal disposition the
   * Runner's settle coordinator reaches records its Session's retirement intent
   * here, right after the lease releases. Absent → Sessions are never retired
   * (pre-#148 behaviour); the worktree teardown then falls back to
   * `finalizeWorkspace` for a Run with no Session. */
  sessionRetirement?: SessionRetirementHook;
  /** The single-writer merge train (issue #163): the ONE process-global
   * {@link MergeTrainCoordinator} an Epic member's Run merges through, in place of
   * the direct auto-merge path. Absent → members fall back to the plain
   * `AutoDrive.onCompleted` merge (pre-#163 behaviour). Its `escalate` is wired
   * (in app.ts) to {@link Runner.settleEscalatedForMember}, so the coordinator
   * must be shared with the Runner that owns that callback. */
  mergeTrain?: MergeTrainCoordinator;
  /** Per-context git circuit breaker (issue #199): shared with the Auto-Runner
   * so a context whose git workspace-prep keeps fast-failing is backed off (and
   * ultimately escalated) instead of being re-spawned at fork-rate. Absent →
   * no breaker (a git-prep failure settles as before); the Auto-Runner must be
   * given the SAME instance for the backoff/pick sides to agree. */
  gitBreaker?: GitCircuitBreaker;
  /** Start-funnel gate for parallel-Epic members (issue #159): true while a
   * mirrored Task is an Epic member whose integration base isn't ready to fork
   * from — unresolved, or set to an `epic/<ref>` branch that does not currently
   * exist in git (#231). {@link Runner.beginRun} refuses to spawn such a Run (a
   * `DomainError` the REST/MCP start surface returns as 409, the Auto-Runner
   * catches and leaves the Task ready), so no member forks off a missing
   * integration branch — the hand-started counterpart to the Auto-Runner's pick
   * gate. Async (the branch-existence check hits git). Absent → not gated. */
  epicBaseNotReady?: (task: TaskRow) => boolean | Promise<boolean>;
  postMerge?: PostMergeHook;
}

interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
  /** The branch tip the implementation started from. */
  baseRev?: string;
  /** Whether a direct-mode context was already dirty at Run start — captured
   * before the agent touches it, so a dirty/concurrently-editable context is
   * not snapshotted (its pre-existing edits would otherwise be swept in). */
  startDirty?: boolean;
}

interface ActiveRun {
  runId: number;
  taskId: number;
  child: ChildProcess;
  driver: AcpDriver;
  /** Sampler context for the live-usage tailer (ADR 0010). */
  harnessId: string;
  harness: HarnessConfig;
  cwd: string;
  /** Latest current-activity line, updated from the run's session updates. */
  activity: string | null;
  /** Set when the agent calls `finish_task` — stops the auto-drive continue loop. */
  agentFinished: boolean;
  /** Set (with a reason) when the agent calls `escalate_task` — routes to a human. */
  escalateReason: string | null;
  /**
   * Operator steering messages queued while the Run is driving, drained FIFO at
   * the next turn boundary (never mid-turn — see {@link Runner.steer}). Each
   * delivered message is a fresh prompt turn, so a native Run that would have
   * settled after one turn takes the steer instead, and an afk Run's steer
   * jumps ahead of the auto-drive continue nudge without spending its budget.
   */
  steerQueue: string[];
  /**
   * True while the agent has *ended its turn and is parked* between continue
   * prompts — not mid-tool-call. The premature-closure backstop
   * ({@link Runner.reopenClosedMirrored}) only stops an agent that has ended
   * its turn, so it never SIGKILLs one mid-work. False during a prompt turn and
   * once the Run leaves the continue loop to settle.
   */
  idle: boolean;
  /**
   * Latched by {@link Runner.reopenClosedMirrored} when the poll settles this
   * Run out from under {@link Runner.drive}. `drive` checks it after each await
   * and skips its own settle so the Run isn't finished twice.
   */
  externallySettled: boolean;
  /**
   * True while the Run can accept operator steers. It opens immediately before
   * the first prompt starts, so setup work cannot accept a steer into an idle
   * ACP session, and closes synchronously once the steering loop starts to
   * settle. A steer is therefore injected, queued for a real turn boundary, or
   * cleanly rejected with 409, never accepted and dropped.
   */
  steerable: boolean;
  /**
   * Whether this Run's harness implements ACP `_session/steering` (mid-turn
   * injection). `undefined` until the first in-flight steer probes it; then
   * cached true/false so a non-supporting harness (codex/copilot) is probed
   * only once and every later steer falls straight through to boundary queueing.
   */
  steerSupported?: boolean;
  /**
   * Cancels an in-flight command verifier (issue #135). Verification runs in
   * `verifying` after the builder harness is gone, so a process/server shutdown
   * ({@link Runner.shutdown}) aborts this to kill the verifier's child promptly
   * rather than wait out its (up to 10-minute) timeout.
   */
  verifyAbort: AbortController;
}

/**
 * Spawns a task's harness, drives it over ACP, persists its small structured
 * facts and an overwritten tool-call snapshot, and settles the task's state from the
 * outcome. A Run is one or more builder turns: the first turn plus, when an
 * actionable verification fails, a bounded run of self-heal turns (issue #137).
 */

/**
 * The corrective context threaded into a self-heal turn (issue #137): why the
 * previous turn's verification failed, surfaced to the builder as feedback so
 * it can fix the cause. `attempt` is the 1-based heal number (audit + the turn
 * queue's idempotency key).
 */
interface HealContext {
  reason: string;
  output: string;
  attempt: number;
  continuation: DeterministicContinuation;
  condensedContext: string | null;
}

/**
 * Thrown by {@link Runner.resolveBaseBranch} when a worktree Run's base branch
 * cannot be resolved to a real branch name (issue #198): the base repo is on a
 * detached HEAD (no current branch) and the Task carries no explicit
 * `baseBranch`. Rather than record the literal `base_branch: "HEAD"` and fork /
 * merge against nothing — silently defeating worktree isolation once a merging
 * has left the base repo detached — the Runner catches this around
 * `prepareWorkspace` and routes it to `settleEscalated` (operator-legible). The
 * `reason` tells the operator how to fix it: reattach the base repo to a branch,
 * or set the Task's base.
 */
export class BaseBranchUnresolved extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'BaseBranchUnresolved';
  }
}

/**
 * Thrown inside {@link Runner.prepareWorkspace} when a worktree Run's resolved
 * base is an Epic integration branch (`epic/<ref>`) that does NOT currently
 * exist (issue #159): the create-before-set ordering guarantees the branch
 * existed when the member's `baseBranch` was assigned, not that it still exists
 * when the member finally spawns — a restart, a degraded tracker scan, or a
 * retire can leave the durable base column pointing at a branch that has since
 * gone. Forking off it fast-fails `git worktree add … invalid reference`, which
 * `classifyGitFailure` would read as PERMANENT and escalate to a human. This is
 * instead a *transient* condition: the reconcile re-cuts the branch on a healthy
 * poll, so the Runner settles the Run back to `ready` (non-escalating) to be
 * re-picked, rather than handing a false permanent failure to an operator. The
 * belt-and-suspenders backstop to {@link RunnerOptions.epicBaseNotReady}'s
 * start-funnel gate, which catches the common case one poll earlier. */
export class EpicBaseNotReady extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'EpicBaseNotReady';
  }
}

/**
 * The outcome of one builder turn ({@link Runner.driveOnce}, issue #137).
 * `actionable-fail` — a `block` verdict — is the SOLE heal-eligible result: the
 * turn deliberately did not settle, handing the failure up to the heal loop.
 * Every other ending (proceed→merge/review, inconclusive→escalate, unresolved,
 * error, operator-settled) is `terminal`: the Run was already settled or parked
 * inside the turn, and the loop stops.
 */
type TurnOutcome =
  | { kind: 'terminal' }
  | { kind: 'actionable-fail'; reason: string; output: string };

/** The merging freshness gate's verdict (ADR-0041): merge at `oid`, hand a
 * failed re-entry (rebase conflict / verification fail) up to the unified
 * Attempt loop, or Escalate. `train` is set for an Epic member — its merge-train
 * outcome, obtained inside the same fresh window. */
type MergeGate =
  | { kind: 'fresh'; oid: string; train: MergeTrainOutcome | null }
  | { kind: 'turn'; outcome: TurnOutcome }
  | { kind: 'escalate'; reason: string };

/** Wall-clock bound on one integration-refresh corrective turn (issue #315) —
 * a merge-conflict resolution, so double the critic's read-only bound. */
const EPIC_REFRESH_RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;

export class Runner {
  private readonly runOperations = new Map<number, Operation>();
  private active = new Map<number, ActiveRun>(); // by run id
  /** Set once {@link shutdown} kills the harnesses on process/server close, so a
   * drive loop reacting to its SIGKILLed harness leaves the Run `running` for
   * boot reconciliation to record as interrupted, rather than settling it a
   * spurious `failed` (issue #113). */
  private shuttingDown = false;

  private readonly gitBreaker: GitCircuitBreaker | undefined;
  private readonly epicBaseNotReady: RunnerOptions['epicBaseNotReady'];
  private readonly events: RunnerEvents;
  private readonly worktreesDir: string;
  private readonly keys: RunnerOptions['keys'];
  private readonly autoDrive: AutoDrive | undefined;
  private readonly getWorkspace: RunnerOptions['getWorkspace'];
  private readonly postMerge: RunnerOptions['postMerge'];
  /** The single-writer merge train an Epic member's Run merges through (issue
   * #163); undefined on a server with no parallel-Epic execution. */
  private readonly mergeTrain: MergeTrainCoordinator | undefined;
  /** Per-Task single-flight gate over the integration-completion loop (ADR-0046):
   * a Task runs at most one integration attempt at a time, so an overlapping
   * completion coalesces onto the in-flight one instead of racing it. Keyed by
   * `task.id`; the entry is dropped once the completion resolves. */
  private readonly completionGates = new Map<number, () => Promise<MergeGate>>();
  /** Injectable agent-critic drive (issue #164); undefined → `runCritic` falls
   * back to the real `createAcpCriticDrive`. */
  private readonly criticDrive: RunnerOptions['criticDrive'];
  private readonly urlFor: (task: TaskRow) => string | null;
  private readonly runFacts: RunFactStore;
  /** The Verification attempt log (issue #135/#136): every command/critic
   * verifier invocation against a Run's frozen candidate is appended here. */
  private readonly verificationAttempts: VerificationAttemptStore;
  /** The structured Guardrail-trip observability log (issue #127, ADR-0019):
   * every wall-clock (later token/cost) trip is appended here, and the amber
   * Escalation card reason derives from it. */
  private readonly guardrailEvents: GuardrailEventStore;
  /** The per-Session turn queue (issue #116): a corrective Attempt turn is
   * recorded here, single-flight per Session, before the builder re-drives it. */
  private readonly turnQueue: TurnQueueStore;
  /** The Execution Chain store (issue #129, reliability-design Unit A): mints /
   * resolves the persisted `execution_chains` identity a Run belongs to, so a
   * cumulative token/cost budget is charged across every Run that continues one
   * line of work (retry / crash-resume / corrective turn) and a
   * retry cannot reset the counter to bypass the ceiling. */
  private readonly chainStore: ExecutionChainStore;
  /** The durable Session store (issue #141, reliability-design Unit C): every
   * dispatch records a Session capturing the harness's `initialize`
   * capabilities alongside the Run, without changing Run behaviour. */
  private readonly sessionStore: SessionStore;
  private readonly attempts: AttemptStore;
  /** The shared terminal-disposition coordinator (issue #113/#114): every Run
   * settle — drive-loop, operator cancel/complete — funnels here
   * so the winning disposition is decided by precedence, once. */
  private readonly settleCoordinator: RunSettleCoordinator;
  private readonly sessionRetirement: SessionRetirementHook | undefined;
  private readonly tailer: LiveUsageTailer;
  /** One incremental session-log reader per active Run (#217): the tailer tick
   *  advances it off the event loop; the Activity snapshot and spend guard read
   *  its cached `latest()`. Created lazily once a session id exists, dropped on
   *  `tailer.stop`. */
  private readonly readers = new Map<number, SessionTailReader>();
  /** Bounded per-Run ACP rollups, retained across corrective turns. */
  private readonly toolCallTotals = new Map<number, Map<string, number>>();
  /** The latest turn's ACP-reported input footprint per run — the context-usage
   * source for harnesses whose session log the tailer cannot read (stub, codex). */
  private readonly lastTurnContextTokens = new Map<number, number>();
  /** Keyed by taskId: an operator message that should seed the FIRST turn of the
   * next Run spawned for the task (the settled-Session steer continuation). Set by
   * {@link steerSettled}, consumed once by the run's first {@link driveOnce}. */
  private readonly pendingOperatorSeed = new Map<number, string>();
  /** Reduced, bounded progress traces. Raw ACP payloads are discarded at
   * ingest, so neither memory nor detector work grows with a Run. */
  private readonly progressEvents = new Map<number, ProgressEvent[]>();
  private readonly progressSequences = new Map<number, number>();
  /** The latest unpaired tool action is retained even when its surrounding
   * trace ages out, preserving the progress guardrail's slow-tool suspension. */
  private readonly outstandingProgressActions = new Map<number, ProgressEvent>();
  /** Spend-Guardrail (issue #128) poll cadence in ms; how often the live token/
   * cost usage snapshot is checked against a Run's frozen budget. */
  private readonly spendPollMs: number;
  /** Spend-Guardrail (issue #128) grace window in ms: how long a configured
   * spend cap may go unmeasurable before it Escalates rather than silently
   * degrading to wall-clock-only enforcement. */
  private readonly spendGraceMs: number;
  /** Work Context lease heartbeat (issue #122) cadence in ms: how often the
   * coordinator-driven timer bumps the lease's liveness heartbeat + phase-scoped
   * expiry, independent of agent/tool output. */
  private readonly leaseHeartbeatMs: number;
  /** The MCP endpoint agents should call back to; set once the server listens. */
  mcpUrl: string | null = null;

  constructor(
    private readonly runStore: RunStore,
    private readonly taskService: TaskService,
    private readonly leaseStore: WorkContextLeaseStore,
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
    this.mergeTrain = options.mergeTrain;
    this.gitBreaker = options.gitBreaker;
    this.epicBaseNotReady = options.epicBaseNotReady;
    this.criticDrive = options.criticDrive;
    this.urlFor = options.urlFor ?? (() => null);
    this.spendPollMs = options.spendGuardrail?.pollMs ?? 1000;
    this.spendGraceMs = options.spendGuardrail?.graceMs ?? 60_000;
    this.leaseHeartbeatMs = options.leaseHeartbeat?.intervalMs ?? 30_000;
    this.runFacts = new RunFactStore(this.asyncDb);
    this.attempts = new AttemptStore(this.asyncDb);
    this.verificationAttempts = new VerificationAttemptStore(this.asyncDb);
    this.guardrailEvents = new GuardrailEventStore(this.asyncDb);
    this.turnQueue = new TurnQueueStore(this.asyncDb);
    this.chainStore = new ExecutionChainStore(this.asyncDb);
    this.sessionStore = new SessionStore(this.asyncDb);
    // PONC-aware (issue #115): the Runner's settle path is what operator-cancel
    // (`cancelForTask` → `settleTaskRun`) and force-complete travel through, and
    // that path can reach a Run parked in `review`/`merging` while a
    // `MergeCoordinator.merge()` is mid-flight. Feeding the same append-only
    // `merge_journal` (keyed on `this.asyncDb`, so it reads the very PONC the
    // review-side coordinator wrote) makes this coordinator honour the Point Of
    // No Cancel too: a cancel racing in after the PONC is clamped out and the
    // merge stands — without this, that cancel would win here and "un-merge" an
    // already-merged Run (the bug reliability-design §0.3 exists to prevent).
    this.settleCoordinator = new RunSettleCoordinator(
      this.runStore,
      this.taskService,
      this.leaseStore,
      this.runFacts,
      (run) => this.events.onRunFinished?.(run),
      new MergeJournalStore(this.asyncDb),
      options.sessionRetirement,
    );
    this.sessionRetirement = options.sessionRetirement;
    this.tailer = new LiveUsageTailer(
      {
        sample: (runId) => this.sampleSnapshot(runId),
        emit: (runId, snapshot) => this.events.onRunUsage?.({ runId, snapshot }),
        // A live snapshot is decoration; a DB hiccup must never fail a run.
        persist: (runId, snapshot) => {
          // Fire-and-forget now that update is async: a swallowed rejection keeps
          // a DB hiccup off the run, and the next tick or finish flush retries.
          void this.runStore.update(runId, { liveUsage: JSON.stringify(snapshot) }).catch(() => {});
        },
      },
      options.tailerCadence,
    );
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * A live view of every active Run for the Activity snapshot (issue #51):
   * each running Run's ids plus its freshest live-usage snapshot. Reads the
   * tailer's cached `latestSnapshot` (#217) — the ~1s tick keeps it current
   * without this endpoint re-parsing the whole log on every poll.
   */
  async activeSnapshots(): Promise<{ runId: number; taskId: number; snapshot: RunUsageSnapshot | null }[]> {
    return Promise.all(
      [...this.active.values()].map(async (a) => ({
        runId: a.runId,
        taskId: a.taskId,
        snapshot: await this.latestSnapshot(a.runId),
      })),
    );
  }

  /** Start a run for a ready task. Returns the created run immediately. */
  async start(taskId: number): Promise<RunRow> {
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
   * ADR-0041 "Reject with guidance": the operator's guidance becomes the
   * feedback of the escalated Attempt and of the next one, the attempt budget
   * restarts (`AttemptStore.budgetBase` — history numbering is untouched), and
   * the loop resumes on the same ticket with a fresh Run cut from the base
   * branch (the escalated Run's branch stays as evidence until its Session
   * retires).
   */
  async resumeWithGuidance(task: TaskRow, guidance: string, startNow = false): Promise<void> {
    const run = (await this.runStore.listForTask(task.id)).at(-1);
    const escalated = (await this.attempts.listForTask(task.id)).findLast((attempt) => attempt.state === 'escalated');
    if (escalated) await this.attempts.setFeedback(escalated.id, guidance);
    const nextNumber = Math.max(escalated?.number ?? 0, run?.attempt ?? 0) + 1;
    const nextAttempt = await this.attempts.ensureForRun(task.id, nextNumber, Date.now());
    let choice: 'full' | 'condensed' | undefined;
    if (run) {
      const continuation = await this.decideContinuation(task, run, await this.getWorkspace?.(task.workspaceId));
      await this.attempts.setContinuation(nextAttempt.id, continuation);
      choice = continuation.path === 'continued-session' ? 'full' : 'condensed';
    }
    // The condensed section is composed at dispatch (from the prior Session), not
    // baked into the Task prompt, which must stay the operator's text plus feedback.
    await this.taskService.requeue(task.id, guidance, choice);
    // Reject requeues to `ready`; the Auto-Runner picks it up when capacity frees
    // (ADR-0048). Force-start now only for the warm-Session "start now" override,
    // which deliberately bypasses the ceiling the way a manual Run does.
    if (startNow) await this.start(task.id);
  }

  /**
   * Escalate a ready ticket the scheduler could not spawn (trigger 3, a
   * permanent infrastructure failure such as its integration branch staying
   * missing): claim it, record a Run + Attempt for the fact, and settle
   * `escalate` through the coordinator — the same recorded-fact path every
   * other escalation takes. A ticket that left `ready` meanwhile is left alone.
   */
  async escalateUnspawned(taskId: number, reason: string): Promise<void> {
    const task = await this.taskService.claimReady(taskId);
    if (!task) return;
    const run = await this.runStore.create(task.id);
    await this.attempts.ensureForRun(task.id, run.attempt, run.startedAt);
    await this.settleEscalated(task, run, reason, {});
  }

  /**
   * ADR-0041 "Close": the ticket is cancelled; remove its branch and worktree
   * (the Session retirement drain owns the worktree) and close the tracker
   * issue. Every step is a best-effort output side-effect.
   */
  async cleanupClosed(task: TaskRow, run: RunRow | undefined): Promise<void> {
    if (run) {
      try {
        await this.sessionRetirement?.onRunSettled(run, 'operator-cancel');
      } catch (err) {
        logger.error(`task ${task.id} close: session retirement failed: ${String(err)}`);
      }
      // The worktree goes now, not on the retirement drain's cadence: the
      // branch it checks out cannot be deleted while it exists.
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
      // A settled-Run event drives the retirement drain (which retires the Session row) and a scheduler refill.
      this.events.onRunFinished?.(await this.runStore.get(run.id));
    }
    if (this.autoDrive && !(await this.autoDrive.closeTicket(task, `Closed by a Harmonic operator without merging (task ${task.id}).`))) {
      logger.error(`task ${task.id} close: tracker issue could not be closed`);
    }
  }

  /**
   * Spawn a run for a task the caller already flipped to working — the
   * mirrored pick, whose sequence is flip (the lock) → recheck → claim →
   * spawn, so the flip merges before the tracker write, not with it (issue #32).
   */
  async launchClaimed(taskId: number, parent?: SpanContext): Promise<RunRow> {
    const task = await this.taskService.get(taskId);
    if (task.state !== 'working') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; launchClaimed expects a task already flipped to working`);
    }
    return this.beginRun(task, parent);
  }

  /** Validate the harness, snapshot Guardrails, create the run row, and drive it. Shared by start / launchClaimed. */
  private async beginRun(task: TaskRow, parent?: SpanContext): Promise<RunRow> {
    // Parallel-Epic start-funnel gate (issue #159): an Epic member whose
    // integration base isn't ready to fork from must not spawn — its `epic/<ref>`
    // branch is unresolved or not confirmed live this poll, so `git worktree add`
    // off it would fast-fail. Enforced HERE, the shared funnel, so a hand-started
    // Run (REST/MCP `start` → 409) is blocked identically to an auto-picked one
    // (the Auto-Runner's `launchClaimed` catch leaves the Task ready). The
    // reconcile re-cuts the branch and re-marks it live, opening the gate.
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
    const ws = (await this.getWorkspace?.(task.workspaceId)) ?? { guardrailBudget: null, guardrailProgress: null };
    const snapshot: RunGuardrailSnapshot = {
      guardrailConfig: resolveGuardrails(ws, config),
      priceTable: resolvePrices(config.prices),
    };
    // The Execution Chain this Run charges its cumulative budget against
    // (issue #129): inherited from the line of work this Run continues (a
    // same-Task new attempt), or a fresh chain when it starts a new line.
    const chainId = await this.chainStore.resolveForTask(task);
    const created = await this.runStore.create(task.id, snapshot, chainId);
    await this.attempts.ensureForRun(task.id, created.attempt, created.startedAt);
    const key = this.workContextKeyFor(task, created);
    // Resolved ahead of the claim: look up whoever holds the Work Context key and
    // whether they share this Run's line of work, exactly what `sharesLineOfWork`
    // computed inside the single run+lease transaction before RunStore (ADR-0029
    // #203) and the lease store (#206) moved to the async Db.
    const existingLease = await this.leaseStore.getByKey(key);
    const existingOwner = existingLease ? await this.runStore.get(existingLease.ownerRunId) : null;
    const sharesLine = this.sharesLineOfWork(existingOwner, created);
    // Claim the Work Context lease: the unique-key CAS (#118) rejects a second
    // afk Run into an already-owned context. Enforced HERE, the shared funnel, so
    // REST / MCP / Auto-Runner / a second process are blocked identically — not
    // only pickNext. `acquireOrTransfer` is itself one async write-queue
    // transaction (its read-then-write is atomic), but the Run row and the lease
    // are still separate write units — RunStore.create predates a shared-tx API —
    // so a rejected claim compensates by deleting the just-created Run rather than
    // rolling both back together. No orphan is left, as the old single-transaction
    // rollback guaranteed.
    //
    // A same-line-of-work predecessor's retained lease is handed off rather than
    // conflicting (issue #124): if `created` continues the Execution Chain of the
    // current key holder, acquireOrTransfer re-points the lease instead of
    // throwing; an unrelated holder still hits the unique-key CAS. The predicate
    // is pinned to the holder observed above — if it changed under the await, fall
    // back to "don't transfer" and let the CAS decide.
    try {
      await this.leaseStore.acquireOrTransfer(
        key,
        created.id,
        'running',
        (existingOwnerRunId) => existingOwnerRunId === existingLease?.ownerRunId && sharesLine,
      );
    } catch (err) {
      // Direct isolation's single checkout serialises to one worker per context,
      // but a second worker attaching to an already-claimed direct Work Context is
      // the operator's accepted risk (ADR-0046), not a block: the existing lease
      // stays with its owner and this Run proceeds in the same live checkout. Trace
      // it at debug so it is reconstructable from logs, never surfaced to the
      // operator. Worktree mode is unchanged — its per-Run key never collides, so a
      // conflict there is a real error and still compensates + propagates.
      if (task.isolationMode !== 'worktree' && err instanceof DomainError && err.code === 'conflict') {
        logger.debug(
          `task ${task.id} run ${created.id}: second worker attaching to already-claimed direct Work Context "${key}"` +
            ` (held by run ${existingLease?.ownerRunId ?? 'unknown'})`,
        );
      } else {
        // Swallow the compensating delete's own error so the original lease-CAS
        // conflict is always what propagates (a delete failure leaves at most an
        // orphan `running` row the boot-time markInterrupted sweep reclaims).
        await this.runStore.delete(created.id).catch(() => {});
        throw err;
      }
    }
    const run = created;
    // Retry & reject continuation (issue #147): if this Run continues a prior
    // rejected, Session-bound Run, bind it to that same Session so dispatch
    // reloads the conversation (`session/load`) instead of a cold `session/new`.
    // Done outside the claim transaction (like `drive`), so a continuation that
    // can't bind still dispatches fresh — never blocked.
    const bound = await this.bindContinuationIfEligible(task, run);
    const operation = startOperation({
      type: 'run',
      parent,
      attributes: {
        'task.id': task.id,
        'run.id': bound.id,
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

  operationParent(runId: number): SpanContext | undefined {
    return this.runOperations.get(runId)?.spanContext;
  }

  async finishRunOperation(runId: number): Promise<void> {
    const operation = this.runOperations.get(runId);
    if (!operation) return;
    const run = await this.runStore.get(runId);
    if (run.state === 'running') return;
    this.runOperations.delete(runId);
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

  /** Whether the Run currently holding a Work Context is a predecessor that
   * `successor` continues — a retry / reject continuation sharing the same
   * Session, so the builder worktree keeps exactly one owner across the
   * handover (issue #124, reliability-design §0.5). Today the lineage is read
   * from the Execution Chain (#129) — the durable line-of-work identity
   * threaded across retry / reject-continue / resume — because a successor's
   * `sessionRowId` is not yet known at claim time; #110 will bind this to the
   * Session row once a successor carries its predecessor's `sessionRowId`
   * forward. */
  private sharesLineOfWork(existingOwner: RunRow | null, successor: RunRow): boolean {
    if (successor.chainId == null) return false;
    return existingOwner?.chainId != null && existingOwner.chainId === successor.chainId;
  }

  /**
   * Resolve the Session a retry/reject continuation should reload (issue #147).
   * The follow-up Run continues the line of work of a prior Run of the same
   * Task that a human rejected. Returns the most-recent such prior Run, its
   * durable Session, and the continuation trigger — or null when there is
   * nothing to continue (a fresh Task, no Session-bound rejected prior, or a
   * retired-and-swept Session). Only `human-reject` has a live producer today:
   * a corrective Attempt re-drives the *same* Run, so it never reaches here.
   */
  private async resolveContinuationSource(
    task: TaskRow,
  ): Promise<{ prior: RunRow; session: SessionRow; trigger: ContinuationTrigger } | null> {
    const priors = await this.runStore.listForTask(task.id); // ordered by attempt asc
    for (let i = priors.length - 1; i >= 0; i--) {
      const prior = priors[i]!;
      if (prior.sessionRowId === null) continue;
      try {
        const session = await this.sessionStore.get(prior.sessionRowId);
        return { prior, session, trigger: 'human-reject' };
      } catch {
        continue; // the Session row is gone (retired + swept) — dispatch fresh
      }
    }
    return null;
  }

  /**
   * If `run` continues a prior rejected Session-bound Run, bind it to that
   * Session so dispatch reloads the conversation (issue #147). Composes the pure
   * seams — `assessResumeEligibility` (#142: is the Session reloadable into this
   * environment?), `planSessionContinuation` (#147: how the trigger continues),
   * `SessionStore.reactivate` (#148: un-idle a retained Session). Eligible → the
   * Run inherits the prior `sessionRowId`/harness session id (dispatch then takes
   * the `session/load` branch and `recordDispatch` upserts the same row, so
   * `sessionRowId` stays stable); incompatible → the Run is returned unchanged
   * for a fresh `session/new`. `offer-choice` (a human reject) resolves to the
   * same-Session "continue full" option UNLESS the operator explicitly picked
   * `'condensed'` in the reject dialog (issue #170): a condensed re-attempt opts
   * out of the bind so dispatch takes the fresh `session/new` branch, carrying
   * only the reviewer feedback into its prompt — the estimate is recorded either
   * way for the audit trail. Best-effort and total: any failure falls through to
   * a cold dispatch, never blocking the Run.
   */
  private async bindContinuationIfEligible(task: TaskRow, run: RunRow): Promise<RunRow> {
    try {
      const src = await this.resolveContinuationSource(task);
      if (!src) return run;
      const env: ResumeEnvironment = {
        harness: src.session.harness,
        adapterVersion: adapterVersion(task.harness),
        model: task.model,
        // The Session's own recorded permission mode is the only mode known
        // pre-handshake; `AcpDriver.load` + the post-handshake setMode do the
        // authoritative live re-verification. Conservative on purpose.
        availablePermissionModes: src.session.permissionMode ? [src.session.permissionMode] : [],
        cwd: repoKey(task.workingDir),
      };
      const stored = { ...sessionFacts(src.session), cwd: repoKey(src.session.cwd) };
      if (!assessResumeEligibility(stored, env).eligible) return run;

      const plan = planSessionContinuation(src.trigger, sessionWarmthFacts(src.session), Date.now());
      const estimate = plan.mode === 'offer-choice' ? plan.continueFull.estimate : null;
      // Same `session-continuation` audit fact whether the bind happens or not —
      // `choice`/`bound` are the only things that vary, so build it in one place.
      const appendFact = (choice: 'condensed' | 'full' | 'silent', bound: boolean) =>
        this.runFacts.append(
          run.id,
          'session-continuation',
          {
            fromRunId: src.prior.id,
            sessionRowId: src.session.id,
            harnessSessionId: src.session.harnessSessionId,
            trigger: src.trigger,
            choice,
            bound,
            estimate,
          },
          Date.now(),
        );

      // #170: an operator who picked "start condensed" in the reject dialog opts
      // out of the same-Session bind — the re-attempt dispatches fresh (only the
      // feedback rides its prompt). Record the declined continuation for the
      // audit trail, then fall through to a cold dispatch. Only a human-reject
      // `offer-choice` is condensable; automated `silent-continue` always binds.
      if (plan.mode === 'offer-choice' && task.continuationChoice === 'condensed') {
        await appendFact('condensed', false);
        return run;
      }

      const bound = await this.runStore.update(run.id, {
        sessionRowId: src.session.id,
        sessionId: src.session.harnessSessionId,
      });
      try {
        await this.sessionStore.reactivate(src.session.id, Date.now());
      } catch {
        /* best-effort; reactivate is a no-op unless the Session is idle */
      }
      await appendFact(plan.mode === 'offer-choice' ? 'full' : 'silent', true);
      return bound;
    } catch {
      return run; // never let a continuation attempt block a dispatch
    }
  }

  /** The Work Context lease key for this Run, matching prepareWorkspace's
   * worktree path/branch exactly so the claimed key and the actual checkout agree. */
  private workContextKeyFor(task: TaskRow, run: RunRow): string {
    if (task.isolationMode === 'worktree') {
      return workContextKey({
        isolationMode: 'worktree',
        workingDir: task.workingDir,
        worktreePath: join(this.worktreesDir, `run-${run.id}`),
        branch: `harmonic/task-${task.id}-run-${run.attempt}`,
      });
    }
    return workContextKey({ isolationMode: 'direct', workingDir: task.workingDir });
  }

  /** Kill the harness of a task's active run (task cancellation).
   *
   * operator-cancel outranks every other disposition (§0.3): a harness exit the
   * SIGKILL triggers can still append its own fact, but the coordinator keeps the
   * Run `cancelled`. The Task was already cancelled by the caller, so the
   * projection leaves it untouched (taskAction none). */
  async cancelForTask(taskId: number): Promise<void> {
    // Every caller invokes this fire-and-forget (REST/MCP cancel + delete), so a
    // rejection here has no awaiter and would surface as an unhandled rejection
    // that takes the daemon down. A cancel is a best-effort operational action:
    // contain its own errors (the run-gone race is already a no-op in
    // settleTaskRun; anything else is logged, not fatal).
    try {
      await this.settleTaskRun(taskId, 'operator-cancel', { runState: 'cancelled', taskAction: 'none', reason: null });
    } catch (err) {
      logger.error(`cancelForTask(${taskId}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stop a task's active run because an operator force-completed it (the task is
   * already `done` by the time we get here). Mirrors {@link cancelForTask}
   * but settles the Run `completed`: SIGKILL even mid-turn, and drive()'s catch
   * no-ops (finish is idempotent, and its settle only fires while the task is
   * still `working`). The Task is already `done`, so the projection leaves it
   * untouched (taskAction none); the post-SIGKILL harness-exit fact loses to
   * this agent-finish.
   */
  async completeForTask(taskId: number): Promise<void> {
    await this.settleTaskRun(taskId, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'none', reason: null });
  }

  /**
   * Settle a task's Run through the coordinator with `type`/`projection`, whether
   * it is the live harness in `active` (SIGKILLed here) or a `running` Run with
   * no live process (a resume re-entry awaiting dispatch). Shared by operator
   * cancel and force-complete, which differ only in the disposition they record.
   */
  private async settleTaskRun(taskId: number, type: RunFactType, projection: SettleProjection): Promise<void> {
    let handled = false;
    for (const active of this.active.values()) {
      if (active.taskId !== taskId) continue;
      handled = true;
      await this.settleRunIfPresent(taskId, active.runId, type, projection);
      this.kill(active);
    }
    if (handled) return;
    const parked = (await this.runStore.listForTask(taskId)).find((r) => r.state === 'running');
    if (parked) await this.settleRunIfPresent(taskId, parked.id, type, projection);
  }

  /**
   * Settle a run, tolerating its row having been deleted concurrently. The
   * get→append settle spans awaits and does not hold the run's existence stable,
   * so a racing delete — `beginRun`'s lease-conflict compensating delete
   * (which explicitly leaves a transient `running` row) or a task-delete cascade
   * — can merge after the row was read (an FK violation on the fact insert) or
   * before it (a `not_found` read). A run that no longer exists cannot be
   * cancelled, so both mean the settle is a no-op, not an error.
   */
  private async settleRunIfPresent(
    taskId: number,
    runId: number,
    type: RunFactType,
    projection: SettleProjection,
  ): Promise<void> {
    try {
      await this.coordinateSettle(await this.taskService.get(taskId), await this.runStore.get(runId), type, projection);
    } catch (err) {
      if (isForeignKeyViolation(err) || (err instanceof DomainError && err.code === 'not_found')) return;
      throw err;
    }
  }

  /**
   * The agent-driven finish signal (`finish_task` MCP tool): mark this task's
   * active Run so the auto-drive continue loop stops re-prompting it. Returns
   * whether an active Run was found (false if the task isn't running here).
   */
  markAgentFinished(taskId: number): boolean {
    return this.forActiveTask(taskId, (active) => {
      active.agentFinished = true;
    });
  }

  /**
   * The agent-driven stop signal (`escalate_task` MCP tool): the agent says it
   * is blocked. No human drives a ticket (ADR-0041), so this ends the Attempt as
   * failed with the reason as feedback — the loop retries and only the exhausted
   * cap escalates. Returns whether a Run matched.
   */
  markEscalate(taskId: number, reason: string): boolean {
    return this.forActiveTask(taskId, (active) => {
      active.escalateReason = reason;
    });
  }

  /**
   * Steer a task's active Run (issue: steer a running Task; ADR-0018 mid-turn
   * injection). When a turn is in flight and the harness has not already
   * shown it lacks ACP `_session/steering`, the message is injected into the
   * RUNNING turn — pre-empting the current generation without cancelling it,
   * so the operator's redirect merges immediately. Otherwise (a parked/idle
   * Run, or a harness that doesn't support the RPC — codex/copilot) the
   * message is queued and delivered as a fresh prompt turn at the next turn
   * boundary, same as before. Records a `steer_injected` or `steer_queued`
   * lifecycle event so the message survives on the Run's event stream either
   * way. Rejects (false ⇒ 409) once the matched Run has closed its
   * {@link ActiveRun.steerable steerable} gate — i.e. it has already
   * committed to settling — rather than accepting a steer that would then be
   * silently dropped. Returns whether a running, steerable Run accepted the
   * steer (false ⇒ the task isn't running here, or its Run is no longer
   * steerable).
   */
  async steer(taskId: number, text: string): Promise<boolean> {
    const active = [...this.active.values()].find((a) => a.taskId === taskId);
    if (!active || !active.steerable) return false;
    // A turn is in flight (not parked) and the harness has not been shown to
    // lack steering → inject into the running turn now, pre-empting the current
    // generation without cancelling it. Opt into promptRequired so an idle
    // session never makes the harness start an untracked turn.
    if (!active.idle && active.steerSupported !== false) {
      try {
        const res = await active.driver.steer([{ type: 'text', text }], { steering: { idleBehavior: 'promptRequired' } });
        if (res.outcome === 'injected') {
          active.steerSupported = true;
          const event = await this.runStore.appendEvent(active.runId, { type: 'lifecycle', payload: { event: 'steer_injected', text } });
          this.events.onRunEvent?.(event);
          return true;
        }
        // 'promptRequired' (the turn ended between the idle check and the RPC →
        // session idle): the harness ran nothing. Fall through to queueing.
        active.steerSupported = true;
      } catch {
        // No _session/steering on this harness (codex/copilot, or older
        // claude-acp): remember it and never probe the RPC again for this Run.
        active.steerSupported = false;
      }
    }
    // Queue for the next turn boundary (parked run, idle session, or unsupported
    // harness). Re-check the gate: a settle may have begun during the RPC await.
    if (!active.steerable) return false;
    active.steerQueue.push(text);
    const event = await this.runStore.appendEvent(active.runId, { type: 'lifecycle', payload: { event: 'steer_queued', text } });
    this.events.onRunEvent?.(event);
    return true;
  }

  /**
   * Continue a settled Task's warm Session with an operator message. When no Run
   * is active (so {@link steer} declined) but the Task's last Session-bound Run
   * left a Session that is BOTH resumable into this environment and still inside
   * its harness warm window, spawn a fresh Run bound to that Session whose FIRST
   * turn is the operator's message — a follow-up in the same conversation rather
   * than a cold restart. Returns false (→ the route 409s) when there is nothing
   * warm to continue, so the operator is never silently dropped onto a fresh,
   * context-less Session. Scoped to escalated Tasks (the "ended without closure"
   * case): a done/merged Task has finished, not parked awaiting a nudge.
   */
  async steerSettled(taskId: number, text: string): Promise<boolean> {
    if ([...this.active.values()].some((a) => a.taskId === taskId)) return false; // a Run is active — steer() owns it
    const task = await this.taskService.get(taskId);
    if (task.state !== 'escalated') return false;
    const src = await this.resolveContinuationSource(task);
    if (!src) return false;
    // The Session must be resumable into this environment AND still warm; else the
    // operator message would merge on a cold/fresh Session with no conversation
    // context, which is not a continuation.
    const env: ResumeEnvironment = {
      harness: src.session.harness,
      adapterVersion: adapterVersion(task.harness),
      model: task.model,
      availablePermissionModes: src.session.permissionMode ? [src.session.permissionMode] : [],
      cwd: repoKey(task.workingDir),
    };
    const stored = { ...sessionFacts(src.session), cwd: repoKey(src.session.cwd) };
    if (!assessResumeEligibility(stored, env).eligible) return false;
    const warmWindowMs = HARNESS_SESSION_WARM_WINDOWS_MS[src.session.harness];
    if (warmWindowMs === undefined || Date.now() - src.session.lastActiveAt >= warmWindowMs) return false;
    // Continue full on the warm Session (`requeue(...'full')` → bindContinuation
    // reloads it); the operator message seeds the new Run's first turn.
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

  /** Apply `fn` to a task's active Run, if any is running here. */
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
      // Best-effort final flush; the process is going down, so fire-and-forget
      // the now-async stop rather than block shutdown on it (#217).
      void this.tailer.stop(active.runId);
      active.verifyAbort.abort();
      this.kill(active);
    }
    this.active.clear();
    this.readers.clear();
  }

  private spawnHarness(
    task: TaskRow,
    harness: HarnessConfig,
    cwd: string,
    extraEnv: Record<string, string>,
  ): ChildProcess {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...harness.env,
      HARMONIC_MODEL: task.model,
      ...adapterFor(task.harness).spawnEnv({ model: task.model, cwd, sessionLogDir: harness.sessionLogDir }),
      ...extraEnv,
    };
    return spawn(harness.command, harness.args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /**
   * The branch a worktree Run is cut from and merges back onto (issue #157,
   * ADR-0024): the Task's explicit `baseBranch`, or the base repo's current
   * branch when unset. Cutting from the resolved base (rather than the base
   * repo's current HEAD) is what lets a Run fork off an arbitrary base — later,
   * an Epic's shared integration branch — without the shared working dir having
   * it checked out.
   *
   * The current branch is read via `symbolicBranch` (null on a detached HEAD),
   * NEVER `currentBranch` (`--abbrev-ref`, which returns the literal `HEAD` when
   * detached): with no branch and no explicit base it throws
   * {@link BaseBranchUnresolved} — the "why" and disposition live on that class.
   */
  private async resolveBaseBranch(task: TaskRow): Promise<string> {
    // An Epic member (durable `mapRef`) forks from — and merges onto — its Epic's
    // integration branch, never develop (issue #334). The reconcile retargets its
    // `baseBranch` to `epic/<mapRef>` before it is pickable, and the start-funnel
    // gate ({@link RunnerOptions.epicBaseNotReady}) holds it until then. Last-line
    // invariant: a member that reaches resolution with a base that is not yet its
    // integration branch (it raced the retarget) must NOT fall through to the
    // symbolic-HEAD default below and silently fork off develop. Surface it as the
    // transient it is ({@link EpicBaseNotReady}) so the Run re-queues. Bounded by
    // the branch existing, matching the gate: a `mapRef` whose `epic/<ref>` is
    // never cut (a nesting spine parent's child) resolves normally, not looped.
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
    // `symbolicBranch` returns null for BOTH a detached HEAD and a non-git dir,
    // so probe HEAD to tell them apart: `revParse` throws a GitError in a
    // non-repo — let it propagate to a generic execution failure, exactly as
    // before this guard existed. A repo on a detached HEAD resolves here, so it
    // escalates (issue #198) rather than recording `base_branch: "HEAD"`.
    await Git.revParse(task.workingDir, 'HEAD');
    throw new BaseBranchUnresolved(
      `base repo ${task.workingDir} is on a detached HEAD with no current branch, and the Task has no explicit base branch; ` +
        'reattach the base repo to a branch (e.g. `git checkout <branch>`) or set an explicit base branch on the Task, then retry',
    );
  }

  /**
   * Direct mode runs in place, unlocked. Worktree mode gets a temporary
   * git worktree on branch `harmonic/task-<id>-run-<n>` cut from the
   * {@link resolveBaseBranch resolved base branch}.
   */
  private async prepareWorkspace(task: TaskRow, run: RunRow, resume = false): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') {
      // Direct isolation works in place (ADR-0046): the agent commits directly
      // on the live base branch, so its commits only ever move the branch
      // forward and a passing verification means the work is already where it
      // belongs. There is no detach, no private ref, and no admission gate — a
      // pre-existing dirty tree (changes the agent did not make) is tolerated
      // and never fails the run. Capture the base commit + dirty-state now,
      // before the agent edits anything, so the candidate is the commits the
      // agent adds on top and a pre-existing dirty tree is not swept in.
      const workspace: Workspace = { cwd: task.workingDir, env: {} };
      try {
        workspace.baseRev = await Git.revParse(task.workingDir, 'HEAD');
        // A self-heal turn (issue #137) resumes the Run's own prior work in the
        // same live checkout — which the Run owns for its duration — so it is
        // treated as clean rather than skipped as an operator's stray edits.
        workspace.startDirty = resume ? false : await Git.isDirty(task.workingDir);
      } catch {
        // Not a git repo (or no commits) — leave baseRev unset; no candidate.
      }
      return workspace;
    }

    const path = join(this.worktreesDir, `run-${run.id}`);
    mkdirSync(this.worktreesDir, { recursive: true });

    if (resume) {
      // Self-heal turn (issue #137): resume the Run's prior work in the SAME
      // run-keyed worktree. Since issue #148 the first turn's `finalizeWorkspace`
      // **retains** that worktree (with the run branch checked out and the work
      // committed), so the continuation reuses it in place. Only re-add the
      // checkout if the worktree is genuinely gone — a pre-#148 Run whose first
      // turn removed it, or a crash/retirement that reclaimed it — because
      // `addWorktreeCheckout` fails on an already-present path / already-checked-
      // out branch. The candidate is re-parented on the SAME validated base the
      // first turn recorded, so the re-verify judges the full diff.
      const persisted = await this.runStore.get(run.id);
      const branch = persisted.branch ?? `harmonic/task-${task.id}-run-${run.attempt}`;
      // The base the first turn already validated against wins; otherwise a
      // resumed Run resolves the same base a fresh one would (issue #157).
      const baseBranch = persisted.baseBranch ?? (await this.resolveBaseBranch(task));
      if (!existsSync(path)) {
        await Git.addWorktreeCheckout(task.workingDir, path, branch);
      }
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }

    const baseBranch = await this.resolveBaseBranch(task);
    // Backstop to the start-funnel gate (issue #159): if the resolved base is an
    // Epic integration branch that has gone missing between its assignment and
    // now (a restart / degraded scan / retire raced the spawn), don't let the
    // `worktree add` fast-fail escalate as a false PERMANENT git error — surface
    // it as the transient it is, so the Run re-queues and the reconcile re-cuts.
    if (parseIntegrationBranch(baseBranch) !== null && !(await Git.branchExists(task.workingDir, baseBranch))) {
      throw new EpicBaseNotReady(
        `Epic integration branch ${baseBranch} does not exist yet; it is cut/re-cut on the next tracker poll`,
      );
    }
    const branch = `harmonic/task-${task.id}-run-${run.attempt}`;
    await Git.addWorktree(task.workingDir, path, branch, baseBranch);
    await this.runStore.update(run.id, { branch, baseBranch });
    // A fresh worktree is clean by construction; the base branch is the
    // validated base the candidate is parented on.
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
  }

  /**
   * The shared "verifier configured but no frozen candidate to review" outcome
   * (issue #135/#136): the snapshot was skipped or failed (#134), so there is
   * nothing to characterize — infra doubt. Persist an `inconclusive` attempt and
   * feed its verdict to `combineVerdicts` so the gate Escalates rather than
   * silently passing work it never verified. Shared by every verifier branch in
   * {@link runVerification} so a new verifier can't diverge on this fail-safe.
   */
  private async noVerifiedHeadVerdict(
    task: TaskRow,
    run: RunRow,
    runId: number,
    mechanism: 'command' | 'critic',
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<VerifierVerdict> {
    const persisted = await this.verificationAttempts.append(runId, {
      mechanism,
      inputOid: '',
      verdict: 'inconclusive',
      summary: 'no committed branch head to verify',
      output: '',
      mutated: false,
    });
    const attempt = await this.attempts.getForTaskNumber(task.id, run.attempt);
    if (attempt) {
      const timeline = await this.attempts.createTask(attempt.id, {
        type: mechanism === 'command' ? 'verification' : 'review',
        logLocator: `verification_attempt:${persisted.id}`,
      });
      await this.attempts.updateTask(timeline.id, {
        state: 'failed', verdict: 'inconclusive', startedAt: persisted.ts, endedAt: Date.now(),
      });
    }
    record('lifecycle', { event: 'verification', mechanism, verdict: 'inconclusive' });
    return { verifier: mechanism, verdict: 'inconclusive' };
  }

  /**
   * Run the configured verifiers against the Run's frozen candidate and fold
   * their verdicts into a single Verification decision (issue #135, ADR-0021,
   * reliability-design Unit B). Runs in `verifying`, after `finalize()` has
   * torn the leased workspace down — verification reads the *persisted*
   * candidate ref (`refs/harmonic/candidate/run-<id>`) in the base repo, never
   * the workspace, exactly as the sibling critic would.
   *
   * Both verifiers are wired: the command verifier (#135) and the agent critic
   * (#136, `runCritic`, integrated here in #164), each folding a verdict into the
   * same `combineVerdicts` — a fail/inconclusive from either blocks or escalates
   * the Run so broken work never merges. Also returns whether a verifier actually
   * `ran` (produced a verdict). With no verifier
   * configured the verdict set is empty and `combineVerdicts` returns `proceed`,
   * so a Run behaves exactly as it did before this gate existed.
   *
   * Each completed attempt is persisted (`VerificationAttemptStore`) before its
   * verdict drives the settle, giving a durable per-attempt audit record. A Run
   * that crashes *mid-verify* is `state:'running'`, so crash recovery (#117)
   * sweeps it to `interrupted` — it is never blindly re-run; marking a partial
   * attempt `inconclusive` and idempotent-replay are deferred (reliability-design
   * Unit B, "replay only if the verifier is declared idempotent"). This never
   * throws for a verdict — a missing command, spawn error, timeout, or absent
   * candidate all resolve to `inconclusive`, which the combination treats as
   * fail-safe (Escalate).
   */
  private async runVerification(
    task: TaskRow,
    run: RunRow,
    head: string | null,
    signal: AbortSignal,
    record: (type: 'lifecycle', payload: unknown) => void,
    parent: SpanContext,
    // Whether the agent critic runs. The completion loop re-verifies a replayed
    // rebase with the deterministic verifiers ONLY (ADR-0046): a rebase replays
    // the same diff the critic already reviewed once on the candidate, so
    // re-invoking it per retry buys nothing — the integration behaviour a rebase
    // does exercise is exactly what the deterministic verifiers catch.
    criticEnabled = true,
  ): Promise<{ decision: VerificationDecision; ran: boolean }> {
    const config = this.getConfig();
    const ws = await this.getWorkspace?.(task.workspaceId);
    const { commands, review } = resolveVerifiers(
      ws ?? { verificationCommand: null, verificationCritic: null },
      config,
    );

    const verdicts: VerifierVerdict[] = [];
    // The frozen candidate both verifiers review — read once (it cannot change
    // within a single verifying pass). Null means the snapshot was skipped
    // (dirty direct context) or failed (#134): a configured verifier then has
    // nothing to characterize, which every branch below treats as infra doubt
    // → inconclusive → Escalate, never a silent pass.
    const oid = head;

    for (const command of commands) {
      if (!oid) {
        verdicts.push(await this.noVerifiedHeadVerdict(task, run, run.id, 'command', record));
      } else {
        mkdirSync(this.worktreesDir, { recursive: true });
        const attempt = await runCommandVerifier({
          // The base repo owns the candidate ref/objects (`prepareWorkspace`
          // pins `worktree.repoDir = task.workingDir`); the leased worktree is
          // already gone by now.
          repoDir: task.workingDir,
          candidateOid: oid,
          worktreePath: join(this.worktreesDir, `cmdverify-${run.id}`),
          command,
          signal,
          parent,
          attributes: { 'task.id': task.id, 'run.id': run.id },
        });
        const persisted = await this.verificationAttempts.append(run.id, commandAttemptToInput(attempt));
        const timelineAttempt = await this.attempts.getForTaskNumber(task.id, run.attempt);
        if (timelineAttempt) {
          const timelineTask = await this.attempts.createTask(timelineAttempt.id, { type: 'verification', command: command.command, logLocator: `verification_attempt:${persisted.id}` });
          await this.attempts.updateTask(timelineTask.id, {
            state: attempt.verdict === 'pass' ? 'passed' : 'failed',
            verdict: attempt.verdict,
            startedAt: persisted.ts,
            endedAt: Date.now(),
          });
        }
        record('lifecycle', {
          event: 'verification',
          mechanism: 'command',
          verdict: attempt.verdict,
          summary: attempt.summary,
        });
        verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
        // Commands are ordered and fail-fast. A red command makes later output
        // irrelevant and prevents the review from seeing a broken branch head.
        if (attempt.verdict !== 'pass') break;
      }
    }

    if (criticEnabled && review.enabled && verdicts.every((entry) => entry.verdict === 'pass')) {
      // The agent critic (issue #136/#164, ADR-0021, reliability-design Unit B;
      // containment relaxed by the 2026-08 amendment): a second verdict folded
      // into the same `combineVerdicts`. It reads the frozen candidate from a
      // disposable read-only worktree (read + fetch tools, no mutation), never
      // the live checkout, with the operator's interpolated review prompt.
      if (!oid) {
        verdicts.push(await this.noVerifiedHeadVerdict(task, run, run.id, 'critic', record));
      } else {
        mkdirSync(this.worktreesDir, { recursive: true });
        // The critic's own harness (issue #174 FIX 2): reuses the builder's
        // harness only when `critic.harness` is unset ("Same as task"); a
        // configured critic harness is resolved independently, mirroring the
        // builder's own lookup/guard in `beginRun`.
        const criticHarnessId = review.harness ?? task.harness;
        const criticHarness = config.harnesses[criticHarnessId as keyof typeof config.harnesses];
        if (!criticHarness) {
          throw new DomainError('validation', `critic harness '${criticHarnessId}' is not configured`);
        }
        const attempt = await runCritic({
          repoDir: task.workingDir,
          candidateOid: oid,
          worktreePath: join(this.worktreesDir, `critic-${run.id}`),
          critic: { prompt: review.prompt!, model: review.model!, ...(review.harness ? { harness: review.harness } : {}) },
          fields: driveFields(task, this.urlFor),
          // `runCritic` strips the tracker credentials and registers no MCP
          // servers, and only approves read/fetch tool calls, so the turn is
          // contained (issue #136) regardless of which harness runs it.
          harness: criticHarness,
          harnessId: criticHarnessId,
          parent,
          attributes: { 'task.id': task.id, 'run.id': run.id },
          // Only pass the seam when injected — `exactOptionalPropertyTypes`
          // forbids an explicit `undefined`, and `runCritic` defaults it to the
          // real `createAcpCriticDrive`.
          ...(this.criticDrive ? { drive: this.criticDrive } : {}),
        });
        const persisted = await this.verificationAttempts.append(run.id, criticAttemptToInput(attempt));
        // The harness may not have flushed its log by the session-end boundary,
        // so `attempt.transcriptPath` is often null here; resolve it off the hot
        // path and fill the row once the `${sessionId}.jsonl` merges (ADR-0040).
        if (attempt.transcriptPath === null && attempt.sessionId) {
          void this.captureCriticTranscriptPath({
            attemptId: persisted.id,
            sessionId: attempt.sessionId,
            harnessId: criticHarnessId,
            sessionLogDir: criticHarness.sessionLogDir,
          });
        }
        const timelineAttempt = await this.attempts.getForTaskNumber(task.id, run.attempt);
        if (timelineAttempt) {
          const timelineTask = await this.attempts.createTask(timelineAttempt.id, { type: 'review', logLocator: `verification_attempt:${persisted.id}` });
          await this.attempts.updateTask(timelineTask.id, {
            state: attempt.verdict === 'pass' ? 'passed' : 'failed',
            verdict: attempt.verdict,
            startedAt: persisted.ts,
            endedAt: Date.now(),
          });
        }
        record('lifecycle', {
          event: 'verification',
          mechanism: 'critic',
          verdict: attempt.verdict,
          summary: attempt.summary,
        });
        verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
      }
    }

    if (oid && verdicts.length > 0 && verdicts.every((entry) => entry.verdict === 'pass')) {
      // The recorded branch comes from the store (null for a direct Run, which
      // has no branch), so the freshness gate reads it back off the fact.
      const { branch } = await this.runStore.get(run.id);
      await this.runFacts.append(run.id, 'verified-head', { sha: oid, branch: branch ?? null });
    }

    return { decision: combineVerdicts(verdicts), ran: verdicts.length > 0 };
  }

  /**
   * Merging may only consume the exact branch tip verification recorded, and
   * that tip must already contain the base's current tip so the merge is a
   * fast-forward of the verified tree (ADR-0041). `oid` is the tip to merge —
   * the verified SHA, or the current head when nothing was verified (zero
   * configured verifiers, no candidate).
   */
  private async mergeFreshness(
    task: TaskRow,
    run: RunRow,
  ): Promise<{ fresh: true; oid: string } | { fresh: false; reason: string; oid: string }> {
    const facts = await this.runFacts.list(run.id);
    const fact = [...facts].reverse().find((entry) => entry.type === 'verified-head');
    let verified: { sha?: unknown; branch?: unknown } = {};
    if (fact) {
      try {
        verified = JSON.parse(fact.payload) as typeof verified;
      } catch {
        // Unparseable fact: fall back to the candidate below rather than merge blind.
      }
    }
    // A direct Run has no branch — its verified tip is HEAD on the live base
    // branch (ADR-0046); a worktree Run's tip is on the recorded run branch.
    const rev = typeof verified.branch === 'string' && verified.branch ? verified.branch : (run.branch ?? 'HEAD');
    const head = await Git.revParse(task.workingDir, rev).catch(() => null);
    const expected = (typeof verified.sha === 'string' ? verified.sha : run.candidateOid) ?? head;
    if (expected === null) return { fresh: true, oid: '' };
    if (head !== expected) return { fresh: false, reason: 'branch head moved after verification', oid: expected };
    if (run.baseBranch) {
      const baseTip = await Git.revParse(task.workingDir, run.baseBranch).catch(() => null);
      if (baseTip !== null && !(await Git.isAncestor(task.workingDir, expected, baseTip))) {
        return { fresh: false, reason: `base '${run.baseBranch}' advanced after verification`, oid: expected };
      }
    }
    return { fresh: true, oid: expected };
  }

  /**
   * The Attempt's Rebase Task (ADR-0041): rebase the ticket branch checked out
   * at `worktreePath` onto the base's current tip, recording one timeline row
   * with the real outcome. The single place a rebase row is written — at
   * Attempt start and on a merging freshness re-entry alike. A conflict is
   * left in progress in the worktree: resolving it is the agent's work.
   */
  private async runRebaseTask(
    task: TaskRow,
    attemptNumber: number,
    attemptStartedAt: number,
    worktreePath: string,
    baseBranch: string,
  ): Promise<{ ok: true; tip: string } | { ok: false; conflict: boolean; detail: string }> {
    const attempt = await this.attempts.ensureForRun(task.id, attemptNumber, attemptStartedAt);
    const row = await this.attempts.createTask(attempt.id, { type: 'rebase', logLocator: `git:rebase:${baseBranch}` });
    await this.attempts.updateTask(row.id, { state: 'running', startedAt: Date.now() });
    const baseOid = await Git.revParse(task.workingDir, baseBranch);
    const rebased = await Git.rebaseOnto(worktreePath, baseOid);
    if (!rebased.ok) {
      // A conflict is a `fail` verdict the agent can act on; a git fault (a
      // disposed worktree, a dirty tree) is infra doubt — `inconclusive`.
      await this.attempts.updateTask(row.id, {
        state: 'failed',
        verdict: rebased.conflict ? 'fail' : 'inconclusive',
        endedAt: Date.now(),
        logLocator: `git:rebase:${baseBranch}@${baseOid}\n${rebased.detail}`,
      });
      return { ok: false, conflict: rebased.conflict, detail: rebased.detail };
    }
    await this.attempts.updateTask(row.id, {
      state: 'passed',
      verdict: 'pass',
      endedAt: Date.now(),
      logLocator: `git:rebase:${baseBranch}@${baseOid}`,
    });
    return { ok: true, tip: rebased.rebasedTip };
  }

  /** A non-`proceed` verdict with a candidate: hand the failed Attempt up to
   * the unified Attempt loop with the last verifier's output as feedback. */
  private async verificationFailTurn(
    run: RunRow,
    decision: VerificationDecision,
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<TurnOutcome> {
    const attempts = await this.verificationAttempts.list(run.id);
    const output = attempts[attempts.length - 1]?.output ?? '';
    record('lifecycle', { event: 'verification-actionable-fail', reason: decision.reason });
    const reason = decision.outcome === 'block' ? decision.reason : `verification ${decision.outcome}: ${decision.reason}`;
    return { kind: 'actionable-fail', reason, output };
  }

  /**
   * Integration completion (ADR-0046), single-flight per Task: a Task runs at
   * most one integration attempt at a time, so an overlapping completion
   * coalesces onto the in-flight one rather than racing it onto the base. The
   * loop body is {@link completeIntegration}; the gate is dropped once it
   * resolves.
   */
  private freshenForMerge(
    task: TaskRow,
    run: RunRow,
    workspace: Workspace,
    attemptNumber: number,
    autoDriven: boolean,
    signal: AbortSignal,
    record: (type: 'lifecycle', payload: unknown) => void,
    parent: SpanContext,
  ): Promise<MergeGate> {
    const inFlight = this.completionGates.get(task.id);
    if (inFlight) return inFlight();
    const gate = singleFlight(() =>
      this.completeIntegration(task, run, workspace, attemptNumber, autoDriven, signal, record, parent),
    );
    this.completionGates.set(task.id, gate);
    return (async () => {
      try {
        return await gate();
      } finally {
        this.completionGates.delete(task.id);
      }
    })();
  }

  /**
   * The completion loop (ADR-0046). Publishes a fresh candidate — an Epic member
   * through the merge train, any other worktree Run through {@link mergeIntoBase}'s
   * checkout-aware CAS (`casUpdateRef` off a checked-out base, a coherent
   * fast-forward on it), which re-asserts freshness so a concurrent publish is
   * refused rather than overwritten. A moved base is NORMAL, not a failure: the
   * Run re-enters Rebase → Verification on the SAME Attempt and Session and
   * re-verifies the replayed tree with the DETERMINISTIC verifiers only (the
   * critic reviewed this diff once on the candidate). The one skip of that
   * re-verify is a pure no-op fast-forward (base already an ancestor of the
   * candidate); there is no path-intersection shortcut. Bounded by the configured
   * integration-retry limit (`task.integrationRetries`); a base that keeps
   * advancing escalates plainly rather than tight-retrying. A rebase conflict or
   * a failing re-verification is a failed Attempt for the unified loop; direct
   * mode (no branch) or a git fault Escalates.
   *
   * A thin wrapper over {@link completionLoop} that, on any exit, records one
   * terminal `moving-base` run-fact with the final retry count (ADR-0046, #368) —
   * derived from the loop's own `moving-base` lifecycle events so it is crash-safe
   * and needs no persisted counter; absent when the base never moved.
   */
  private async completeIntegration(
    task: TaskRow,
    run: RunRow,
    workspace: Workspace,
    attemptNumber: number,
    autoDriven: boolean,
    signal: AbortSignal,
    record: (type: 'lifecycle', payload: unknown) => void,
    parent: SpanContext,
  ): Promise<MergeGate> {
    // The loop's own moving-base retry tally — transient loop state, never a
    // persisted per-retry counter (ADR-0046, #368). Reading it back here rather
    // than re-counting the event log means the terminal fact is the exact final
    // count, independent of whether the fire-and-forget per-retry events have
    // flushed yet.
    const retries = { count: 0 };
    try {
      return await this.completionLoop(task, run, workspace, attemptNumber, autoDriven, signal, record, parent, retries);
    } finally {
      // Best-effort terminal telemetry; never let it mask the loop's outcome.
      if (retries.count > 0) await this.runFacts.append(run.id, 'moving-base', { retries: retries.count }).catch(() => {});
    }
  }

  private async completionLoop(
    task: TaskRow,
    run: RunRow,
    workspace: Workspace,
    attemptNumber: number,
    autoDriven: boolean,
    signal: AbortSignal,
    record: (type: 'lifecycle', payload: unknown) => void,
    parent: SpanContext,
    retries: { count: number },
  ): Promise<MergeGate> {
    let current = await this.runStore.get(run.id);
    // How many times this completion may re-enter Rebase → Verification because
    // the base advanced meanwhile (ADR-0046). Each re-entry costs a deterministic
    // verification pass, so a base that keeps moving escalates plainly rather than
    // spinning. Resolved per-Task (Task → Workspace → global default).
    const maxReentries = task.integrationRetries;
    for (let reentries = 0; ; reentries += 1) {
      const freshness = await this.mergeFreshness(task, current);
      let stale = freshness.fresh ? null : freshness.reason;
      let train: MergeTrainOutcome | null = null;
      if (stale === null) {
        const member = autoDriven ? this.epicMemberFor(task, current, freshness.oid) : null;
        if (member) {
          train = await this.mergeTrain!.submit(member);
          if (train.status === 'stale') stale = train.reason;
        } else if (
          task.isolationMode === 'worktree' && current.branch && current.baseBranch &&
          (!autoDriven || this.autoDrive?.mergeFateFor(task) === 'auto-merge')
        ) {
          const merged = await mergeIntoBaseAndRunPostMerge({
            repoDir: task.workingDir,
            baseBranch: current.baseBranch,
            branch: current.branch,
            expectedOid: freshness.oid,
            leaseHeld: true,
            parent,
            attributes: { 'task.id': task.id, 'run.id': run.id },
          }, this.postMerge);
          if (!merged.ok) {
            if (merged.reason !== 'stale-head' && merged.reason !== 'stale-base' && merged.reason !== 'target-advanced') {
              return { kind: 'escalate', reason: `merging failed (${merged.reason}): ${merged.detail}` };
            }
            stale = merged.detail;
          } else {
            record('lifecycle', { event: 'merged', oid: merged.oid, mode: merged.mode, baseBranch: merged.baseBranch });
          }
        }
      }
      if (stale === null) return { kind: 'fresh', oid: freshness.oid, train };
      record('lifecycle', { event: 'rebase-required', reason: stale });
      if (!workspace.worktree || !current.baseBranch) {
        return { kind: 'escalate', reason: `${stale}; no ticket branch to rebase` };
      }
      if (reentries >= maxReentries) {
        return { kind: 'escalate', reason: `base kept advancing through ${maxReentries} rebase+verify re-entries` };
      }
      // A moving base is normal, not an alarm (ADR-0046, #368): record each rebase
      // re-entry as a fire-and-forget lifecycle event carrying its attempt index
      // (`3/5`) so the UI shows a single quiet collapsed line whose prominence
      // rises only near the bound. The UI derives its cumulative count from these
      // events; the tally here feeds only the terminal fact, never a persisted
      // per-retry counter.
      retries.count += 1;
      record('lifecycle', { event: 'moving-base', attempt: retries.count, of: maxReentries });
      const rebase = await this.runRebaseTask(task, attemptNumber, run.startedAt, workspace.worktree.path, current.baseBranch);
      if (!rebase.ok) {
        // A raw GitError never reaches the operator (git.ts): the rebase Task row
        // keeps the git detail for diagnosis. A git fault is infra doubt.
        if (!rebase.conflict) {
          return { kind: 'escalate', reason: `could not rebase onto '${current.baseBranch}' (git error); see the rebase step` };
        }
        return this.resolveConflictOrEscalate(task, run, current.branch, current.baseBranch, record);
      }
      current = await this.runStore.update(run.id, { candidateOid: rebase.tip });
      record('lifecycle', { event: 'phase', phase: 'verifying' });
      // Deterministic verifiers only on the replayed tree (ADR-0046); see the
      // `criticEnabled` param on runVerification.
      const { decision } = await this.runVerification(task, current, rebase.tip, signal, record, parent, false);
      if (this.shuttingDown) return { kind: 'turn', outcome: { kind: 'terminal' } };
      if (decision.outcome !== 'proceed') {
        return { kind: 'turn', outcome: await this.verificationFailTurn(run, decision, record) };
      }
    }
  }

  /**
   * A completion-rebase content conflict (ADR-0046): up to `N`
   * (`task.conflictResolveTurns`) agentic resolve-turns, then escalate plainly.
   * The count is the `conflict-resolve-turn` event tally rather than an in-memory
   * counter so the bound survives the corrective turn, re-entries, and a
   * crash-resume; messaging never carries the raw git conflict dump. `N === 0`
   * escalates on the first conflict.
   */
  private async resolveConflictOrEscalate(
    task: TaskRow,
    run: RunRow,
    branch: string | null,
    baseBranch: string,
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<MergeGate> {
    const budget = task.conflictResolveTurns;
    const spent = (await this.runStore.listEvents(run.id)).filter(
      (event) => event.type === 'lifecycle' && (event.payload as { event?: string }).event === 'conflict-resolve-turn',
    ).length;
    if (spent >= budget) {
      const where = branch ? `branch '${branch}' onto '${baseBranch}'` : `onto '${baseBranch}'`;
      const after = budget === 0 ? '' : ` after ${budget} resolve ${budget === 1 ? 'turn' : 'turns'}`;
      return {
        kind: 'escalate',
        reason: `content conflict rebasing ${where}${after}; review this run's diff and resolve it`,
      };
    }
    record('lifecycle', { event: 'conflict-resolve-turn', baseBranch, turn: spent + 1, of: budget });
    return {
      kind: 'turn',
      outcome: {
        kind: 'actionable-fail',
        reason: `rebase onto '${baseBranch}' hit a content conflict — resolve the conflicts in the checkout, then finish`,
        output: '',
      },
    };
  }

  /**
   * Tear the leased workspace down before the task settles. A **direct** Run
   * worked in place — its commits already sit on the live branch (ADR-0046), so
   * there is nothing to tear down. A **worktree** Run has its work snapshotted
   * onto its branch and — since issue #148 — the worktree **retained** (bound to
   * the Run's Session), not dropped, so the checkout survives the human-rejection
   * window and Session retirement is the sole owner of its removal. Runs before
   * the task settles so an escalated task always has its branch as evidence.
   */
  private async finalizeWorkspace(task: TaskRow, run: RunRow, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    const { repoDir, path } = workspace.worktree;
    // Commit the agent's work onto the run branch (the durable artifact merging
    // merges) — best-effort, so a commit hiccup never blocks teardown.
    await Git.commitAll(path, `harmonic: task ${task.id} run ${run.attempt}`).catch(() => {});
    // Issue #148 (reliability-design Unit C): **retain** the builder worktree so
    // its removal is owned solely by Session retirement — the checkout then
    // survives the human-rejection window and a reject-and-continue merges in the
    // same workspace. Retention requires a Session to own the removal, so bind
    // the worktree to the Run's Session and retain **only if that bind succeeds**.
    // If there is no Session (the best-effort dispatch write never merged) or the
    // bind fails, retirement could never reclaim this worktree — so dispose of it
    // now rather than leak it. This is the only builder-worktree removal outside
    // retirement, and it fires solely for a worktree retirement structurally
    // cannot own; the invariant "retained ⇔ bound ⇔ retirement owns removal" holds.
    const sessionRowId = (await this.runStore.get(run.id)).sessionRowId;
    let retained = false;
    if (sessionRowId != null) {
      try {
        await this.sessionStore.bindWorktree(sessionRowId, repoDir, path, Date.now());
        retained = true;
      } catch {
        retained = false; // ownership not established — fall through to dispose
      }
    }
    if (!retained) {
      await Git.removeWorktree(repoDir, path).catch(() => {});
    }
  }

  /**
   * Drive a Run to a terminal disposition through the unified Attempt loop
   * (issue #310, ADR-0041).
   *
   * The first turn runs through {@link driveOnce}. Any failed Attempt — a
   * verification fail, an unresolved afk turn, an inconclusive verdict with a
   * candidate — does not settle; it records the failure on the closed Attempt
   * and routes a corrective builder turn back through the per-Session turn
   * queue (single-flight), which re-enters `validating`, rebuilds the
   * candidate, and reruns the FULL verifier suite, so a fix for one check
   * can't silently break another. Attempts are bounded by `maxAttempts`
   * (workspace override, then config); exhausting the cap Escalates the Run.
   * An inconclusive verdict with NO candidate Escalates in place — there is
   * nothing a corrective turn could fix. Every other ending settles inside
   * the single turn.
   */
  private async drive(task: TaskRow, run: RunRow, harness: HarnessConfig, parent: SpanContext): Promise<void> {
    const workspace = await this.getWorkspace?.(task.workspaceId);
    const maxAttempts = workspace?.maxAttempts ?? this.getConfig().maxAttempts;
    // The Session key for this Run's turn queue. There is no first-class Session
    // entity yet (reliability-design §0), so the globally-unique Run id anchors
    // it — stable across heal turns even as each turn's ACP session id changes.
    const sessionKey = `run-${run.id}`;
    // The attempt counter is seeded from the run row, so the maxAttempts bound
    // survives a crash-resume of the drive loop rather than being a purely
    // in-memory count. The token/cost SPEND corrective turns consume IS charged
    // cumulatively across the whole Execution Chain (issue #129) — they run
    // inside this Run, so their usage is already in this Run's live snapshot,
    // which the chain-cumulative spend poll folds onto the chain's prior floor.
    let attemptNumber = run.attempt;
    // The budget counts from the last operator "Reject with guidance" (ADR-0041):
    // that escalated Attempt's number is the base, so history numbering keeps
    // growing while the cap restarts.
    const budgetBase = await this.attempts.budgetBase(task.id);
    let healCtx: HealContext | undefined;
    // The turn_queue row id of the corrective turn currently being driven, so it
    // is settled once its turn completes (kept single-flight: at most one).
    let inFlightTurn: number | null = null;
    try {
      for (;;) {
      const outcome = await this.driveOnce(task, run, harness, parent, healCtx, attemptNumber);
      if (inFlightTurn !== null) {
        // The corrective turn we dispatched has run its course — settle its queue
        // row regardless of the verdict; a further fail enqueues the next one.
        try {
          await this.turnQueue.settle(inFlightTurn, 'done');
        } catch {
          // Best-effort audit: the row is a record, not this loop's dispatch
          // mechanism, so a settle race never blocks the Run from finishing.
        }
        inFlightTurn = null;
      }
      if (outcome.kind === 'terminal') return;
      const attempt = await this.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
      const feedback = [outcome.reason, outcome.output].filter(Boolean).join('\n\n');
      if (attemptNumber - budgetBase >= maxAttempts) {
        // The exhausted Attempt is recorded `escalated` (not `failed`): it is the
        // timeline row the escalation surface hangs off, and the number the
        // budget restarts from after a Reject with guidance.
        await this.attempts.finish(attempt.id, 'escalated', Date.now(), feedback);
        await this.settleEscalated(task, await this.runStore.get(run.id), `attempt ${attemptNumber - budgetBase} of ${maxAttempts} failed: ${outcome.reason}`, {});
        return;
      }
      await this.attempts.finish(attempt.id, 'failed', Date.now(), feedback);
      attemptNumber += 1;
      // The Run is the durable owner of the current unified Attempt. Persist
      // this before driving the corrective turn: timeline rows, settling, and
      // a post-crash resume all resolve the current Attempt through runs.attempt.
      run = await this.runStore.update(run.id, { attempt: attemptNumber });
      const nextAttempt = await this.attempts.ensureForRun(task.id, attemptNumber, Date.now());
      const continuation = await this.decideContinuation(task, run, workspace);
      await this.attempts.setContinuation(nextAttempt.id, continuation);
      healCtx = {
        reason: outcome.reason,
        output: outcome.output,
        attempt: attemptNumber - 1,
        continuation,
        condensedContext: continuation.path === 'new-session-condensed' ? await this.condensedContext(run) : null,
      };
      inFlightTurn = await this.enqueueCorrectiveAttempt(run, sessionKey);
      // The next `driveOnce(healCtx)` resets the phase pointer to `executing` and
      // records the re-entry itself (§0.4), so the phase sequence stays fully
      // reconstructable from the event log.
      }
    } finally {
      this.toolCallTotals.delete(run.id);
      this.lastTurnContextTokens.delete(run.id);
      this.progressEvents.delete(run.id);
      this.progressSequences.delete(run.id);
      this.outstandingProgressActions.delete(run.id);
    }
  }

  private async decideContinuation(
    task: TaskRow,
    run: RunRow,
    workspace: Awaited<ReturnType<NonNullable<RunnerOptions['getWorkspace']>>>,
  ): Promise<DeterministicContinuation> {
    const now = Date.now();
    const session = run.sessionRowId === null ? null : await this.sessionStore.get(run.sessionRowId).catch(() => null);
    // Live tailer snapshot → the in-flight turn's ACP usage (self-heal, before the
    // Run persists usage) → the settled Run's persisted usage (review reject). All
    // three are the last turn's raw context footprint; the reuse gate compares it
    // against a raw token limit, so no context-window fraction is involved.
    const persisted = run.usage ? (JSON.parse(run.usage) as RunUsage).contextTokens ?? null : null;
    const contextTokens = (await this.latestSnapshot(run.id))?.contextTokens ?? this.lastTurnContextTokens.get(run.id) ?? persisted;
    return decideAttemptContinuation({
      harness: task.harness,
      contextTokens,
      lastActiveAt: session?.lastActiveAt ?? now,
      contextReuseTokenLimit: workspace?.contextReuseTokenLimit ?? this.getConfig().contextReuseTokenLimit,
      now,
    });
  }

  private async condensedContext(run: RunRow): Promise<string | null> {
    if (run.sessionRowId === null) return null;
    const session = await this.sessionStore.get(run.sessionRowId).catch(() => null);
    if (!session) return null;
    const current = await this.runStore.get(run.id);
    const facts = await this.runFacts.list(run.id);
    const events = await this.runStore.listEvents(run.id);
    return [
      '## Prior session (condensed)',
      'This attempt starts a fresh Session under the deterministic continuation rule.',
      `Prior Session: ${session.harness} / ${session.model} / ${session.harnessSessionId}`,
      `Candidate: ${current.candidateOid ?? '(none produced)'}`,
      `Recorded facts: ${facts.length}; run events: ${events.length}.`,
    ].join('\n');
  }

  /**
   * Put an Attempt N+1 corrective turn through the durable session queue before
   * dispatching it. The row fences the mutation to the failed candidate and
   * lets crash recovery escalate an interrupted corrective turn instead of
   * replaying past the persisted attempt cap.
   */
  private async enqueueCorrectiveAttempt(run: RunRow, sessionKey: string): Promise<number | null> {
    try {
      const oid = (await this.runStore.get(run.id)).candidateOid ?? '';
      const now = Date.now();
      const row = await this.turnQueue.enqueue(
        sessionKey,
        run.id,
        'self-heal',
        {
          expectedPhase: 'verifying',
          expectedGeneration: run.attempt,
          expectedWorkspaceOID: oid,
          expectedFingerprint: oid,
        },
        now,
      );
      await this.turnQueue.claim(row.id, now);
      await this.turnQueue.markInFlight(row.id, `attempt-${run.attempt}-run-${run.id}`, now);
      return row.id;
    } catch {
      return null;
    }
  }

  /**
   * Dispatch the bounded corrective turn for an integration refresh (issue
   * #315). The conflict is between the default branch and `epic/<ref>` itself
   * — no member's worktree can resolve it — so the turn operates on the
   * integration branch: check `epic/<ref>` out into a dedicated worktree,
   * reproduce the conflicted merge of the default branch there (markers +
   * `MERGE_HEAD` left in place), and drive one agent turn against that
   * worktree to resolve and commit it. A running member is still required —
   * it supplies the harness/model the turn runs on; with none, escalate.
   *
   * Called inside the coordinator's merge-train slot for `epic/<ref>`, so the
   * worktree + reproduction here are race-free against member merges, and
   * every pre-turn failure returns `escalated` synchronously — the
   * coordinator's `resolving` flag is only set once this returns
   * `dispatched`. The turn itself must NOT run under that slot (it would
   * stall other members' merges for the whole agent turn), so it is chained as
   * the branch's NEXT train slot before dispatch returns: member merges
   * queue behind it rather than observing the checked-out integration branch
   * mid-resolution and falsely escalating. Once the turn's worktree is
   * removed, {@link runEpicRefreshResolveTurn} re-runs the refresh (`retry`):
   * a resolved merge completes it, an unresolved one re-conflicts into the
   * coordinator's still-conflicts-after-corrective-turn escalation — either
   * way the `resolving` flag settles.
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
    const host = (await this.taskService.list({ state: 'working' })).find((task) => task.baseBranch === branch);
    if (!host) {
      return escalated(`no active Epic member is available to resolve refresh conflict for ${branch}: ${detail}`);
    }
    const harness = this.getConfig().harnesses[host.harness as keyof AppConfig['harnesses']];
    if (!harness) {
      return escalated(`harness '${host.harness}' is not configured to run the refresh corrective turn for ${branch}: ${detail}`);
    }

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
        // A clean reproduction means the conflict evaporated (the branch or
        // default moved since the merge observed it) and the merge is already
        // committed — skip the turn, the retry below completes the refresh.
        conflicted: !reproduced.ok,
        conflictDetail: reproduced.detail ?? detail,
        harness,
        harnessId: host.harness,
        model: host.model,
      });
    void (this.mergeTrain ? this.mergeTrain.runOnIntegrationBranch(branch, turn) : turn())
      .then(() => retry())
      .catch(async (err) => {
        await escalate(target.ref, `refresh re-attempt after the corrective turn failed for ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return { status: 'dispatched' };
  }

  /**
   * One bounded agent turn resolving a reproduced default-branch merge
   * conflict in the `epic/<ref>` worktree (issue #315). Spoken over the same
   * one-shot ACP drive the critic uses ({@link createAcpCriticDrive} /
   * the injectable `criticDrive` seam) — a fresh contained process, no
   * tracker credentials, no Harmonic MCP — since there is no builder Session
   * to host it: the conflict belongs to the Epic, not to any member's Run.
   * Never throws for a failed turn: the worktree is force-removed either way
   * (discarding an unresolved half-merge), and the caller's `retry` re-merges —
   * a committed resolution completes the refresh, anything else re-conflicts
   * and escalates through the coordinator's one-turn bound.
   */
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
      // The turn failed or timed out; the caller's retry re-observes the
      // still-unmerged default branch and escalates through the coordinator.
    } finally {
      await Git.removeWorktree(args.target.repoDir, args.worktreePath).catch(() => {});
    }
  }

  /**
   * The merge train's `escalate` (issue #163), wired in app.ts: a member could
   * not merge (branch missing, unexpected checkout, or a concurrent advance beat
   * its CAS). Hand the Task back to a human exactly as
   * any other afk escalation does — Run failed, Task ready + escalated. This is
   * the SOLE settle authority on a merge-train escalate: `driveOnce` only records
   * the `escalated` outcome and stops, so the Run is never settled twice.
   */
  async settleEscalatedForMember(member: MergeTrainMember, reason: string): Promise<void> {
    const run = await this.runStore.get(member.runId);
    const task = await this.taskService.get(member.taskId);
    await this.settleEscalated(task, run, reason, {});
  }

  /**
   * The {@link MergeTrainMember} for a finishing Run when it is a parallel-Epic
   * member that should merge through the merge train (issue #163), or `null` when
   * it is an ordinary Run that merges the direct way. A member is: a worktree Run
   * whose base is an Epic integration branch (`epic/<ref>`), on a server with
   * the train wired, and whose Merge Fate is `auto-merge` — `open-PR`/`artifact`
   * deliberately never touch the integration branch, so they keep
   * `onCompleted`'s behaviour. `verifiedTip` is the only object the train merges.
   */
  private epicMemberFor(task: TaskRow, run: RunRow, verifiedTip: string): MergeTrainMember | null {
    if (!this.mergeTrain) return null;
    if (task.isolationMode !== 'worktree') return null;
    if (!run.branch || !run.baseBranch) return null;
    if (parseIntegrationBranch(run.baseBranch) === null) return null;
    if (this.autoDrive?.mergeFateFor(task) !== 'auto-merge') return null;
    return {
      runId: run.id,
      taskId: task.id,
      repoDir: task.workingDir,
      integrationBranch: run.baseBranch,
      memberBranch: run.branch,
      verifiedTip,
    };
  }

  /**
   * Persist a turn's run event, fire-and-forget, on the hottest drive path. A
   * racing task-delete cascade can remove the Run row mid-turn, so this append
   * can FK-violate against a Run that no longer exists — dropping the event is
   * correct there, a crashed server is not. The rejection is contained here (it
   * used to reach the process as an unhandled rejection and take the server
   * down); the run-gone race logs at debug, any other failure at error, and the
   * Run settles normally either way (issue #371).
   */
  private recordRunEvent(
    task: TaskRow,
    run: RunRow,
    type: 'permission_request' | 'lifecycle',
    payload: unknown,
  ): void {
    this.runStore
      .appendEvent(run.id, { type, payload })
      .then((event) => {
        this.events.onRunEvent?.(event);
      })
      .catch((err: unknown) => {
        if (isForeignKeyViolation(err)) {
          logger.debug(`task ${task.id} run ${run.id}: dropped ${type} event — run row gone (racing delete)`);
          return;
        }
        logger.error(
          `task ${task.id} run ${run.id}: ${type} event append failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Drive ONE builder turn end to end and report its {@link TurnOutcome}. A
   * `healCtx` re-drives the Run as a self-heal turn (issue #137): it resumes the
   * prior work (`prepareWorkspace(resume)`), prompts the builder with the
   * verification failure as feedback, and re-snapshots over the Run's candidate
   * ref. A `block` verdict returns `actionable-fail` WITHOUT settling — the
   * {@link drive} loop owns the heal decision; every other ending settles or
   * parks here and returns `terminal`.
   */
  private async driveOnce(
    task: TaskRow,
    run: RunRow,
    harness: HarnessConfig,
    parent: SpanContext,
    healCtx?: HealContext,
    attemptNumber = run.attempt,
  ): Promise<TurnOutcome> {
    const record = (type: 'permission_request' | 'lifecycle', payload: unknown) => {
      this.recordRunEvent(task, run, type, payload);
    };
    const toolCalls = this.toolCallTotals.get(run.id) ?? (await this.runStore.listToolCalls(run.id));
    this.toolCallTotals.set(run.id, toolCalls);
    const progressEvents = this.progressEvents.get(run.id) ?? [];
    this.progressEvents.set(run.id, progressEvents);
    const flushToolCalls = async () => {
      await this.runStore.replaceToolCalls(run.id, toolCalls);
    };
    let toolCallFlushTimer: ReturnType<typeof setInterval> | undefined;

    const attemptAtStart = await this.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
    // A turn re-entering an Attempt that already has rows (a crash-resume) does
    // not open it again.
    const opensAttempt = (await this.attempts.listTasks(attemptAtStart.id)).length === 0;

    // Attempt Tasks, rather than Run phases, own the execution pipeline. Runs
    // remain readable compatibility records, but a transition never writes or
    // consults `runs.phase`.
    const advanceTask = async (to: 'verifying' | 'merging') => {
      const attempt = await this.attempts.ensureForRun(task.id, attemptNumber, run.startedAt);
      const rows = await this.attempts.listTasks(attempt.id);
      const implementation = rows.find((row) => row.type === 'implementation' && row.state === 'running');
      if (to === 'verifying' && implementation) {
        await this.attempts.updateTask(implementation.id, { state: 'passed', verdict: 'pass', endedAt: Date.now() });
        return;
      }
      if (to === 'merging') {
        await this.attempts.finish(attempt.id, 'passed');
      }
    };

    // Set on an escalation trigger (ADR-0041): a branch-contract violation or a
    // permanent infrastructure failure. The Run stops and the Task Escalates.
    let escalating: string | null = null;
    // Set when the agent itself stopped short — it asked for a human
    // (`escalate_task`) or a tool needed a permission no human is here to grant.
    // That is a failed Attempt with the reason as feedback, never an escalation.
    let stoppedShort: string | null = null;
    const autoDriven = this.autoDrive?.handles(task) ?? false;

    if (healCtx) record('lifecycle', { event: 'phase', phase: 'executing' });

    let child: ChildProcess;
    let workspace: Workspace;
    let mcpServers: unknown[] = [];
    // Unit C (#141): the harness's `initialize` capabilities, captured mid-
    // handshake, and the durable Session row written once its `sessionId` is
    // known — both filled by the handshake callbacks below and read after it
    // to record the resolved permission mode.
    let sessionInit: AcpInitializeResult | undefined;
    let sessionRowId: number | undefined;
    // A harness that dies without a clean ACP error (codex-acp exiting
    // non-zero mid-handshake) explains itself only on stderr. Retain its
    // tail so the failure reason carries the cause, not a bare exit code;
    // draining the pipe also prevents backpressure on a chatty process.
    let stderrTail = '';
    let stderrFlushed: Promise<void> = Promise.resolve();
    // Every Attempt on a ticket branch opens with its Rebase Task (ADR-0041).
    // A conflict is the agent's work: it stays in progress in the worktree and
    // the implementation turn is told to resolve it — the Attempt continues.
    let rebaseConflict = false;
    try {
      workspace = await this.prepareWorkspace(task, run, healCtx !== undefined);
      if (opensAttempt && workspace.worktree) {
        const baseBranch = (await this.runStore.get(run.id)).baseBranch ?? await this.resolveBaseBranch(task);
        const rebase = await this.runRebaseTask(task, attemptNumber, run.startedAt, workspace.worktree.path, baseBranch);
        if (!rebase.ok) {
          if (!rebase.conflict) throw new Error(`rebase onto ${baseBranch} failed: ${rebase.detail}`);
          rebaseConflict = true;
          record('lifecycle', { event: 'rebase-conflict', baseBranch });
        }
      }
      const attemptTasks = await this.attempts.listTasks(attemptAtStart.id);
      if (!attemptTasks.some((row) => row.type === 'implementation' && row.state === 'running')) {
        const implementation = await this.attempts.createTask(attemptAtStart.id, { type: 'implementation', logLocator: 'session:pending' });
        await this.attempts.updateTask(implementation.id, { state: 'running', startedAt: Date.now() });
      }
      // Workspace prep (its git ops) succeeded — clear any accumulated git
      // backoff for this context, so a later unrelated blip starts fresh (#199).
      this.gitBreaker?.recordSuccess(repoKey(task.workingDir));
      // Agents reach the MCP server with zero setup: a Run Key (its
      // lifetime follows the run's) plus the endpoint, in the environment
      // — and, where the harness supports it (codex), registered directly
      // via ACP `session/new` mcpServers.
      if (this.keys && this.mcpUrl) {
        const runKey = await this.keys.mint(run.id);
        workspace.env.HARMONIC_API_KEY = runKey;
        workspace.env.HARMONIC_MCP_URL = this.mcpUrl;
        mcpServers = adapterFor(task.harness).mcpServers({ url: this.mcpUrl, token: runKey });
      }
      // Process/server shutdown began while this turn was preparing its workspace.
      // Spawning now would launch a harness into a workspace teardown may already
      // be removing (the child's own cwd), whose spawn error has no awaiter once
      // the Run is abandoned. Leave the Run `running` for boot reconciliation to
      // record interrupted — exactly as the post-verify guard below does — rather
      // than spawn on shutdown timing.
      if (this.shuttingDown) return { kind: 'terminal' };
      child = this.spawnHarness(task, harness, workspace.cwd, workspace.env);
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
      // The Run Key may already be minted; it must not outlive the run.
      try {
        void Promise.resolve(this.keys?.revoke(run.id)).catch(() => {});
      } catch {
        // Best-effort; the startup sweep is the backstop.
      }
      if (err instanceof EpicBaseNotReady) {
        // A member raced ahead of its Epic integration branch (issue #159): the
        // branch is transiently missing, not a permanent fault. Settle the Run
        // failed but hand the Task back to `ready` (not escalate) so it re-runs
        // once the reconcile re-cuts the branch — the start-funnel gate holds it
        // there in the meantime. No breaker arm: this isn't a git-fork storm.
        await this.coordinateSettle(task, run, 'failed', {
          runState: 'failed',
          taskAction: 'ready',
          reason: err.reason,
        });
      } else if (err instanceof BaseBranchUnresolved) {
        // A worktree Run whose base cannot be resolved to a real branch because a
        // prior merging left the base repo detached (issue #198) is handed to a
        // human with the operator-legible reason, not settled as a generic
        // execution failure. Operator-fixable: reattach the base repo to a branch.
        await this.settleEscalated(task, run, err.reason, {});
      } else if (err instanceof GitError) {
        // A git workspace-prep failure (issue #199). Record it against the
        // per-context circuit breaker (keyed on the base repo, so colliding
        // worktree/direct Runs share it): the Auto-Runner then backs the whole
        // context off, so the *next* ready Task on this repo isn't re-picked and
        // re-spawning git on the following event-loop tick — turning a fork-rate
        // flood into a few spaced attempts. Escalate this Run to a human —
        // rather than re-queue — when the failure is PERMANENT (a
        // detached/dirty base, a path that already exists, a bad revision: it
        // will never succeed on retry) or when the breaker has now tripped (a
        // transient failure that kept recurring across Runs on this repo).
        const cls = classifyGitFailure([err.stderr, err.message].filter(Boolean).join('\n'));
        const failure = this.gitBreaker?.recordFailure(repoKey(task.workingDir));
        if (cls === 'permanent' || failure?.opened) {
          await this.settleEscalated(task, run, `git workspace preparation failed (${cls}): ${err.message}`, {});
        } else {
          // A one-off transient git failure: nothing was attempted, so hand the
          // ticket back to ready for the next pick — the breaker's backoff bounds
          // the context, not this Run.
          await this.coordinateSettle(task, run, 'failed', { runState: 'failed', taskAction: 'ready', reason: err.message });
        }
      } else {
        // Any other pre-spawn failure is a failed Attempt: the loop retries and
        // the exhausted cap escalates, never a terminal failure (ADR-0041).
        return { kind: 'actionable-fail', reason: err instanceof Error ? err.message : String(err), output: '' };
      }
      return { kind: 'terminal' };
    }

    let finalized = false;
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      // Stop tailing before the log's cwd (worktree) is torn down; this also
      // flushes the final snapshot to the row (ADR 0010: always on finish).
      // Awaited so the reader's last async read finishes before teardown (#217).
      await this.tailer.stop(run.id);
      if (toolCallFlushTimer) clearInterval(toolCallFlushTimer);
      await flushToolCalls().catch(() => {});
      this.readers.delete(run.id);
      this.kill(active);
      try {
        void Promise.resolve(this.keys?.revoke(run.id)).catch(() => {});
      } catch {
        // Revocation is best-effort; keys also die with the database row.
      }
      await this.finalizeWorkspace(task, run, workspace).catch(() => {});
    };

    const driver = new AcpDriver(child, {
      onSessionUpdate: (update, replay) => {
        if (replay) return;
        const seq = (this.progressSequences.get(run.id) ?? 0) + 1;
        this.progressSequences.set(run.id, seq);
        // Session updates are intentionally transient (ADR-0031), but the
        // operator transcript needs them live. Reserve a separate id range so
        // the browser can merge them with its one-time native-log hydration
        // without colliding with parser-assigned transcript ids.
        this.events.onRunLogEvent?.({
          id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
          runId: run.id,
          seq,
          ts: Date.now(),
          type: 'session_update',
          payload: update,
        });
        const progress = toProgressEvents([{ seq, type: 'session_update', payload: update }]);
        if (progress.length > 0) {
          const event = progress[0]!;
          if (event.kind === 'action') {
            this.outstandingProgressActions.set(run.id, event);
          } else if (event.kind === 'result' || event.kind === 'error') {
            const outstanding = this.outstandingProgressActions.get(run.id);
            if (outstanding && (event.ref === undefined || outstanding.ref === undefined || event.ref === outstanding.ref)) {
              this.outstandingProgressActions.delete(run.id);
            }
          }
          progressEvents.push(event);
          if (progressEvents.length > 64) progressEvents.shift();
        }
        const line = activityLine(update);
        if (line) active.activity = line;
        if (update.sessionUpdate === 'tool_call') {
          const name = toolCallName(update, (payload) => adapterFor(task.harness).usage?.toolName(payload) ?? null);
          toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
        }
        observeTool(update); // feed the tool-timeout watchdog (issue #131)
      },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') {
          const options = (params as any)?.options ?? [];
          const grant = () => {
            const pick =
              options.find((o: any) => o.kind === 'allow_always') ??
              options.find((o: any) => o.kind === 'allow_once') ??
              options[0];
            const outcome = pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
            record('permission_request', { request: params, outcome });
            return { outcome };
          };
          // A mirrored Run has no human on this turn, so a permission request is
          // declined and the turn stopped: the Attempt fails with the request as
          // feedback and the loop retries (ADR-0041). Codex asks per-action
          // (on-request) rather than pre-triaging like Claude's auto mode, so it
          // stops sooner — the held-request + Permission-Rule model (ADR-0007,
          // planned for Runs) will replace this with hold-approve-remember.
          if (autoDriven) {
            stoppedShort = `permission request declined (no human on this turn): ${(params as any)?.toolCall?.title ?? 'permission request'}`;
            const outcome = { outcome: 'cancelled' };
            record('permission_request', { request: params, outcome });
            driver.cancel();
            return { outcome };
          }
          return grant();
        }
        // Advertise no fs/terminal capabilities; anything else gets null.
        return null;
      },
    });

    const active: ActiveRun = {
      runId: run.id,
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
      verifyAbort: new AbortController(),
    };
    this.active.set(run.id, active);
    // This remains independent of the usage tailer because a harness may have
    // no native transcript. The overwrite cadence prevents write amplification.
    toolCallFlushTimer = setInterval(() => void flushToolCalls().catch(() => {}), 10_000);
    toolCallFlushTimer.unref?.();

    // Wall-clock Guardrail watchdog (issue #127, ADR-0019). Armed once the
    // session is live (below) for the Run's *remaining* execution budget; a
    // one-shot timer because the execution phases (`executing/validating/
    // verifying`) are a contiguous prefix of the Run — it can only fire while
    // this `driveOnce` is running, and the `finally` clears it the instant the
    // Run parks in `review`, merges, or settles. That is exactly the phase
    // scoping: time a Run spends parked awaiting a human (review SLA) or in a
    // non-interruptible merge never counts, because the watchdog isn't armed
    // then. On fire it appends a structured `guardrail_events` row and settles
    // the Run through the coordinator by precedence — `guardrail-trip` →
    // Escalation, never a direct settle, never a new terminal state.
    let guardrailTimer: ReturnType<typeof setTimeout> | null = null;
    const armGuardrail = async () => {
      const started = await this.runStore.get(run.id);
      const budget = started.guardrailConfig
        ? (JSON.parse(started.guardrailConfig) as ResolvedGuardrails).budget
        : null;
      if (!budget) return; // no snapshot (legacy Run) → no wall-clock guard
      // Resolve the limit's provenance now — at (or within milliseconds of) the
      // Run-start snapshot instant — and capture it, rather than looking it up
      // when the timer fires. The enforced limit is the immutable snapshot's
      // (issue #126); a live workspace lookup at fire time (possibly long after)
      // could attribute the snapshotted limit to a since-changed override.
      const ws = await this.getWorkspace?.(task.workspaceId);
      const configSource = ws?.guardrailBudget ? 'workspace' : 'default';
      const remaining = Math.max(0, wallClockBudgetMs(budget) - (Date.now() - started.startedAt));
      guardrailTimer = setTimeout(async () => {
        guardrailTimer = null;
        if (active.externallySettled) return; // already ended some other way
        const now = await this.runStore.get(run.id);
        if (now.state !== 'running') return; // settled/terminal — nothing to trip
        const attempt = await this.attempts.getForTaskNumber(task.id, run.attempt);
        const attemptTasks = attempt ? await this.attempts.listTasks(attempt.id) : [];
        const activeTask = [...attemptTasks].reverse().find((row) => row.state === 'running');
        if (!activeTask) return; // Attempt has reached merging, which never charges execution time.
        // The critic (`review` Task) is the last verification step, so it charges as `verifying`.
        const guardrailPhase: RunPhase =
          activeTask?.type === 'rebase' ? 'validating' : activeTask?.type === 'implementation' ? 'executing' : 'verifying';
        // Phase-scoped (issue #127, reliability-design Unit A): a trip only
        // counts when observed inside an execution phase. `now - startedAt` is
        // the execution clock precisely because the counted phases are a
        // contiguous prefix — this watchdog is armed only within `driveOnce`,
        // which the Run leaves for `review`/`merging` by *returning*, and the
        // `finally` clears the timer at that point. If the timer nonetheless
        // fires mid-`review`/`merging`, `wallClockTrip` returns null (that phase
        // does not count) and the Run is left alone.
        const trip = wallClockTrip({ elapsedMs: Date.now() - now.startedAt, phase: guardrailPhase, budget });
        if (!trip) return; // fired in a non-counted phase, or not actually over budget
        // Structured evidence first — the card reason derives from this row.
        await this.guardrailEvents.append(now.id, {
          dimension: trip.dimension,
          phase: guardrailPhase,
          limitValue: trip.limitMs,
          observedValue: trip.observedMs,
          configSource,
        });
        const reason = formatBudgetReason(trip);
        record('lifecycle', { event: 'guardrail-tripped', dimension: trip.dimension, reason });
        // Claim the settle so the drive loop's own settle path (unwinding from
        // the killed harness) no-ops instead of finishing the Run twice.
        active.externallySettled = true;
        await this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
        // Interrupt whatever is in flight so `driver.prompt()` / the verifier
        // unwinds and `driveOnce` returns through its `externallySettled` guards.
        active.verifyAbort.abort();
        this.kill(active);
      }, remaining);
      guardrailTimer.unref?.();
    };

    // Token/cost budget Guardrail poll (issue #128, ADR-0019, reliability-design
    // Unit A), extending the wall-clock watchdog's two other `BudgetGuardrail`
    // dimensions. Unlike wall-clock (a single deadline known up front), spend
    // accrues continuously and can only be read from the live-usage snapshot, so
    // this is a poll (like `armToolTimeout`'s hard-tool-timeout watchdog) rather
    // than a one-shot timer. Armed only when a spend cap is actually configured
    // (a Run with neither `tokens` nor `costUsd` set never even starts the
    // interval — wall-clock alone still guards it). Records the same
    // `guardrail_events` row + `guardrail-trip` run_fact + coordinator-settle
    // path as every other Guardrail dimension.
    let spendTimer: ReturnType<typeof setInterval> | null = null;
    const tripSpend = async (
      now: RunRow,
      event: {
        dimension: 'tokens' | 'cost';
        phase: RunPhase;
        limitValue: number;
        observedValue: number;
        configSource: 'default' | 'workspace';
        payload?: unknown;
      },
      reason: string,
    ) => {
      await this.guardrailEvents.append(now.id, event);
      record('lifecycle', { event: 'guardrail-tripped', dimension: event.dimension, reason });
      active.externallySettled = true;
      await this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
      active.verifyAbort.abort();
      this.kill(active);
      if (spendTimer) {
        clearInterval(spendTimer);
        spendTimer = null;
      }
    };
    const armSpendGuardrail = async () => {
      const started = await this.runStore.get(run.id);
      const budget = started.guardrailConfig
        ? (JSON.parse(started.guardrailConfig) as ResolvedGuardrails).budget
        : null;
      if (!budget) return; // no snapshot (legacy Run) → no spend guard
      if (budget.tokens == null && budget.costUsd == null) return; // no spend caps configured
      const priceTable: PriceTable = started.priceTable ? (JSON.parse(started.priceTable) as PriceTable) : {};
      // Resolved at arm time, not fire time — same provenance rule as `armGuardrail`.
      const ws = await this.getWorkspace?.(task.workspaceId);
      const configSource: 'default' | 'workspace' = ws?.guardrailBudget ? 'workspace' : 'default';
      // Prior cumulative spend of this Run's Execution Chain (issue #129): the
      // token/cost already charged by the sibling Runs that continued the same
      // line of work before this one (retry / crash-resume).
      // Summed once at arm time — those Runs are settled, so their frozen usage
      // is immutable for the life of this poll — and each member is priced with
      // ITS OWN frozen price table (issue #126), so a later price edit can't
      // retroactively change what a past Run cost. A member with no recorded
      // usage contributes a 0 floor (see `sumPriorSpend`); self-heal turns need
      // no accounting here because they run inside this same Run.
      const chainMembers = started.chainId == null ? [] : await this.chainStore.listForChain(started.chainId);
      const priorSpend = sumPriorSpend(
        chainMembers
          .filter((member) => member.id !== run.id)
          .map((member): ChainSpend => {
            const usage = member.usage ? (JSON.parse(member.usage) as RunUsage) : null;
            const memberPrices: PriceTable = member.priceTable
              ? (JSON.parse(member.priceTable) as PriceTable)
              : {};
            const memberCost = usage ? costOfUsages([usage], memberPrices) : null;
            return {
              tokens: usage ? totalTokensOf(usage) : null,
              usd: memberCost?.totalUsd ?? null,
              costIncomplete: memberCost?.incomplete ?? true,
            };
          }),
      );
      let unmeasurableSince: number | null = null;
      let spendSampling = false;
      spendTimer = setInterval(() => {
        // The spend guard is a correctness control, so it advances the reader
        // itself (#217 — incremental, off the event loop) rather than riding the
        // tailer's cached snapshot: a budget trip must never lag the real spend.
        // Skip a fire while a prior async evaluation is still reading.
        if (spendSampling) return;
        spendSampling = true;
        void (async () => {
          try {
            if (active.externallySettled) return;
            const now = await this.runStore.get(run.id);
            if (now.state !== 'running') return;
            const snap = await this.sampleSnapshot(run.id);
            const observedTokens = snap ? totalTokensOf(snap.usage) : null;
            const cost = snap ? costOfUsages([snap.usage], priceTable) : null;
            const observedUsd = cost?.totalUsd ?? null;
            const costIncomplete = cost?.incomplete ?? true;
            // Two spend checks against the SAME frozen caps (issue #129 acceptance:
            // a trip fires when EITHER the per-Run or the chain budget is exceeded).
            // The per-Run check is #128's unchanged behaviour; the chain check folds
            // this Run's live usage onto the chain's prior floor, so a retry whose
            // own usage is under the cap still trips once the cumulative crosses it —
            // the reset-and-bypass this guard exists to prevent. `combineSpendOutcomes`
            // prefers a per-Run trip (keeping #128's card evidence) and only reports
            // the chain scope when the cumulative is what pushed it over.
            const runOutcome = spendTrip({ phase: now.phase ?? null, budget, observedTokens, observedUsd, costIncomplete });
            const chainSpend = chainObserved(priorSpend, { tokens: observedTokens, usd: observedUsd, costIncomplete });
            const chainOutcome = spendTrip({
              phase: now.phase ?? null,
              budget,
              observedTokens: chainSpend.tokens,
              observedUsd: chainSpend.usd,
              costIncomplete: chainSpend.costIncomplete,
            });
            const { outcome, scope } = combineSpendOutcomes(runOutcome, chainOutcome);
            if (outcome.kind === 'ok') {
              unmeasurableSince = null;
              return;
            }
            if (outcome.kind === 'unmeasurable') {
              if (unmeasurableSince == null) unmeasurableSince = Date.now();
              if (Date.now() - unmeasurableSince < this.spendGraceMs) return;
              const reason = formatUnmeasurableReason(outcome.dimension);
              const limitValue =
                outcome.dimension === 'tokens' ? (budget.tokens ?? 0) : toMicroUsd(budget.costUsd ?? 0);
              await tripSpend(
                now,
                {
                  dimension: outcome.dimension,
                  phase: now.phase ?? 'executing',
                  limitValue,
                  observedValue: 0,
                  configSource,
                  payload: { unmeasurable: true, graceMs: this.spendGraceMs, scope },
                },
                reason,
              );
              return;
            }
            // outcome.kind === 'trip'
            unmeasurableSince = null;
            const trip = outcome.trip;
            const event =
              trip.dimension === 'tokens'
                ? {
                    dimension: 'tokens' as const,
                    phase: now.phase ?? ('executing' as RunPhase),
                    limitValue: trip.limitTokens,
                    observedValue: trip.observedTokens,
                    configSource,
                    payload: { scope },
                  }
                : {
                    dimension: 'cost' as const,
                    phase: now.phase ?? ('executing' as RunPhase),
                    limitValue: toMicroUsd(trip.limitUsd),
                    observedValue: toMicroUsd(trip.observedUsd),
                    configSource,
                    payload: { limitUsd: trip.limitUsd, observedUsd: trip.observedUsd, scope },
                  };
            const reason = formatBudgetReason(trip);
            await tripSpend(now, event, reason);
          } finally {
            spendSampling = false;
          }
        })();
      }, this.spendPollMs);
      spendTimer.unref?.();
    };

    // Work Context lease heartbeat (issue #122): coordinator-driven, on a
    // wall-clock timer independent of agent/tool output — a Run stuck in a
    // long tool call still bumps its lease's liveness, so the lease never
    // lapses while the Run is genuinely alive. The TTL budget comes from
    // `lease-ttl.ts`, keyed by the Run's current phase.
    let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const armLeaseHeartbeat = async () => {
      const key = this.workContextKeyFor(task, run);
      const beat = async () => {
        if (active.externallySettled) return;
        const now = await this.runStore.get(run.id);
        if (now.state !== 'running') return;
        await this.leaseStore.heartbeat(key, Date.now(), now.phase ?? 'executing');
      };
      await beat(); // set expiry immediately, before the first interval tick
      leaseHeartbeatTimer = setInterval(beat, this.leaseHeartbeatMs);
      leaseHeartbeatTimer.unref?.();
    };

    // Progress Guardrail (issue #131, ADR-0019, reliability-design Unit A). Two
    // paired mechanisms, both OFF unless `guardrails.progress` was enabled in
    // the Run's immutable start snapshot (issue #126):
    //
    //  1. A stall/loop detector (`detectStall`, issue #130) evaluated at each
    //     turn boundary in the drive loop below. On the first detected stall it
    //     delivers exactly ONE nudge through the steer channel (does not spend
    //     the continue budget — ADR-0018); if the Run is still stalled after
    //     that nudge turn it trips → Escalates through the same
    //     `run_fact` + coordinator + `guardrail_events` machinery as the
    //     wall-clock Guardrail.
    //  2. A hard tool-timeout watchdog. The detector deliberately SUSPENDS while
    //     a tool call is outstanding (a slow build is indistinguishable from a
    //     stuck agent), so a genuinely hung tool would otherwise never trip. The
    //     watchdog backstops that rule: a tool call outstanding past the
    //     generous configured bound emits a `tool-timeout` `guardrail_events`
    //     row + a `guardrail-trip` run_fact and Escalates. When it and the
    //     wall-clock both fire, both append `guardrail-trip` facts and the
    //     coordinator's earliest-fact precedence (`projectSettle`) picks the
    //     primary reason — no dimension-priority table needed.
    const progressStart = await this.runStore.get(run.id);
    const progressSnapshot = progressStart.guardrailConfig
      ? (JSON.parse(progressStart.guardrailConfig) as ResolvedGuardrails)
      : null;
    const progressEnabled = progressSnapshot?.progress === true;
    const progressConfigSource: 'default' | 'workspace' = (await this.getWorkspace?.(task.workspaceId))
      ?.guardrailProgress
      ? 'workspace'
      : 'default';
    const toolTimeoutMs =
      progressEnabled && progressSnapshot ? toolTimeoutBudgetMs(progressSnapshot.toolTimeoutMinutes) : null;
    let progressNudged = false;

    // Trip the progress Guardrail to Escalation — shared by both the stall
    // detector and the tool-timeout watchdog. Records structured evidence
    // first, then settles through the coordinator by precedence (`guardrail-trip`
    // → Escalation), exactly like the wall-clock watchdog above. `abort` kills a
    // verifier/prompt in flight (the tool-timeout path fires from a timer that
    // can race an in-flight turn); the boundary stall path passes it too and it
    // is a harmless no-op when nothing is in flight.
    const tripProgressGuardrail = async (
      now: RunRow,
      evidence: { dimension: 'progress' | 'tool-timeout'; limitValue: number; observedValue: number; payload: unknown },
      reason: string,
    ) => {
      await this.guardrailEvents.append(now.id, {
        dimension: evidence.dimension,
        phase: now.phase ?? 'executing',
        limitValue: evidence.limitValue,
        observedValue: evidence.observedValue,
        configSource: progressConfigSource,
        payload: evidence.payload,
      });
      record('lifecycle', { event: 'guardrail-tripped', dimension: evidence.dimension, reason });
      active.externallySettled = true;
      await this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
    };

    // Tool-call liveness, fed from the ACP `session/update` stream (below). A
    // `tool_call` opens an entry; a `tool_call_update` with a terminal status
    // closes it. The watchdog trips on the OLDEST still-open call, so a burst of
    // concurrent tools is bounded by the first to hang.
    const outstandingTools = new Map<string, { startedAt: number; title: string | null }>();
    const observeTool = (update: unknown) => {
      if (!toolTimeoutMs) return; // guardrail off → don't even track
      const u = update as {
        sessionUpdate?: string;
        toolCallId?: unknown;
        title?: unknown;
        kind?: unknown;
        status?: unknown;
      };
      const id = typeof u?.toolCallId === 'string' ? u.toolCallId : null;
      if (!id) return;
      if (u.sessionUpdate === 'tool_call') {
        const title = typeof u.title === 'string' ? u.title : typeof u.kind === 'string' ? u.kind : null;
        outstandingTools.set(id, { startedAt: Date.now(), title });
      } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
        outstandingTools.delete(id);
      }
    };

    let toolTimeoutTimer: ReturnType<typeof setInterval> | null = null;
    const armToolTimeout = () => {
      if (!toolTimeoutMs) return; // guardrail off (or no snapshot)
      // Poll at a fraction of the bound (capped) so a hang is caught within a
      // small fraction of the timeout without a per-tool timer.
      const period = Math.max(1_000, Math.min(toolTimeoutMs, 30_000));
      toolTimeoutTimer = setInterval(async () => {
        if (active.externallySettled) return;
        const now = await this.runStore.get(run.id);
        if (now.state !== 'running') return;
        // Only an execution phase counts (reliability-design Unit A) — the same
        // phase scoping as the wall-clock budget.
        if (!countsTowardExecutionBudget(now.phase ?? null)) return;
        let oldest: { id: string; startedAt: number; title: string | null } | null = null;
        for (const [id, t] of outstandingTools) {
          if (!oldest || t.startedAt < oldest.startedAt) oldest = { id, startedAt: t.startedAt, title: t.title };
        }
        if (!oldest) return; // nothing outstanding right now
        const trip = toolTimeoutTrip({
          outstandingMs: Date.now() - oldest.startedAt,
          limitMs: toolTimeoutMs,
          toolCallId: oldest.id,
          title: oldest.title,
        });
        if (!trip) return;
        await tripProgressGuardrail(
          now,
          {
            dimension: 'tool-timeout',
            limitValue: trip.limitMs,
            observedValue: trip.observedMs,
            payload: { toolCallId: trip.toolCallId, title: trip.title },
          },
          formatToolTimeoutReason(trip),
        );
        // Interrupt whatever is in flight so `driver.prompt()` unwinds and
        // `driveOnce` returns through its `externallySettled` guards.
        active.verifyAbort.abort();
        this.kill(active);
      }, period);
      toolTimeoutTimer.unref?.();
    };

    // Evaluate the stall detector at a turn boundary (called from the drive loop
    // below, where the agent is parked — never concurrent with an in-flight
    // turn). First stall → one nudge via the steer channel; a stall that
    // survives the nudge turn → trip → Escalate. Returns true when it tripped,
    // so the caller breaks the loop to settle.
    const checkProgressAtBoundary = async (): Promise<boolean> => {
      // Off, already settled, or the agent has signalled finish/escalate — in
      // the last case the Run is completing this turn, so a lingering pre-finish
      // stall tail must not nudge or (worse) trip it: honour the finish.
      if (!progressEnabled || active.externallySettled || active.agentFinished || active.escalateReason) return false;
      const outstanding = this.outstandingProgressActions.get(run.id);
      const progressTrace = outstanding && !progressEvents.some((event) => event.seq === outstanding.seq)
        ? [outstanding, ...progressEvents]
        : progressEvents;
      const report = detectStall(progressTrace, { enabled: true });
      if (!report) return false; // progressing, or a tool is outstanding (suspend guard)
      if (!progressNudged) {
        // One nudge, delivered as the next turn by the steer drain just below in
        // the loop. `attempt` is untouched, so it never spends the continue
        // budget (ADR-0018). Recorded so the redirect is visible in the stream.
        progressNudged = true;
        record('lifecycle', { event: 'progress-nudge', pattern: report.pattern });
        active.steerQueue.push(PROGRESS_NUDGE_TEXT);
        return false;
      }
      // Already nudged. Only trip once that nudge has actually been delivered
      // (drained from the queue) and a turn has run — otherwise the same
      // pre-nudge tail would trip before the agent ever saw the nudge.
      if (active.steerQueue.length > 0) return false;
      const now = await this.runStore.get(run.id);
      if (now.state !== 'running') return false;
      await tripProgressGuardrail(
        now,
        {
          dimension: 'progress',
          // A stall has no numeric bound the way wall-clock/tool-timeout do — its
          // thresholds are internal to the detector and pattern-specific — so
          // `limitValue` is 0 (a "no scalar limit" sentinel for this dimension)
          // and the real evidence rides in `payload` (pattern + seqs + signatures).
          limitValue: 0,
          observedValue: report.count,
          payload: { pattern: report.pattern, signatures: report.signatures, seqs: report.seqs },
        },
        formatProgressReason(report),
      );
      return true;
    };

    try {
      // Harnesses with no reliable spawn-time pin (copilot) pin per
      // session instead — sent for every run, `auto` included, because an
      // unpinned session inherits the operator's persisted model choice
      // (issue 25). A rejected pin fails the run like any other request.
      const modelId = adapterFor(task.harness).sessionModelId?.(task.model);
      // Persist the harness session id + the durable Session (Unit C #141) the
      // moment the id is known — shared by the fresh `session/new` and the
      // reload (`session/load`, #147) paths so persistence is identical. It
      // records the harness/model/cwd identity, credential-free MCP templates
      // (secrets stripped, never stored) and the captured `initialize`
      // capability snapshot; on a reload it upserts the SAME row (keyed on
      // harness session id), keeping `run.sessionRowId` stable. Best-effort:
      // written *alongside* the Run, so a Session persistence hiccup never fails
      // a dispatch that would otherwise proceed (AC: in-flight Run unchanged).
      const persistSession = async (harnessSessionId: string) => {
        void this.runStore.update(run.id, { sessionId: harnessSessionId }).catch(() => {});
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
            capabilities: sessionInit,
            adapterVersion: adapterVersion(task.harness),
            now: Date.now(),
          });
          sessionRowId = session.id;
          void this.runStore.update(run.id, { sessionRowId: session.id }).catch(() => {});
          // The timeline decoration must not delay the ACP handshake. A steer
          // can arrive as soon as the session becomes live.
          void this.attempts.getForTaskNumber(task.id, run.attempt).then(async (attempt) => {
            if (!attempt) return;
            const implementation = (await this.attempts.listTasks(attempt.id)).find((row) => row.type === 'implementation' && row.state === 'running');
            if (implementation) await this.attempts.updateTask(implementation.id, { logLocator: `session:${session.id}` });
          }).catch(() => {});
          if (transcriptPath === null && transcriptResolver) {
            void this.captureTranscriptPath({ sessionId: harnessSessionId, sessionRowId: session.id, sessionLogDir: harness.sessionLogDir, transcriptResolver });
          }
        } catch {
          /* best-effort; the Session is additive, the Run proceeds regardless */
        }
      };
      // Snapshot the harness's `initialize` capabilities (incl. `loadSession`)
      // for the durable Session; shared by both dispatch paths.
      const onInitialize = (result: AcpInitializeResult) => {
        sessionInit = result;
      };
      // Index this worktree as its own jCodeMunch repo BEFORE the handshake, so
      // the agent's code-index queries hit the branch it is working on rather
      // than the canonical checkout jCodeMunch serves for a bare `.`
      // (`code-index.ts`). It must run here, not just before the prompt: the
      // multi-second index would otherwise sit between the handshake and the
      // first prompt and push the harness's `${sessionId}.jsonl` past
      // `captureTranscriptPath`'s short resolve window, leaving the Run with no
      // recorded transcript. Direct Runs work in the canonical checkout itself —
      // which jCodeMunch already indexes — so they are skipped (and its shared
      // index is never reaped at teardown). Best-effort: null ⇒ skip injection.
      const codeIndexRepoId = workspace.cwd !== task.workingDir ? await indexWorktree(workspace.cwd) : null;
      // A corrective Attempt follows the recorded continuation decision. Reuse
      // reloads the prior Session with feedback appended below. A condensed path
      // starts a fresh Session and retains the prior Session row for transcript
      // lookup until the new dispatch replaces the Run binding.
      const continueSessionId = healCtx === undefined || healCtx.continuation.path === 'continued-session'
        ? run.sessionId
        : null;
      if (continueSessionId) {
        const outcome = await driver.load({
          sessionId: continueSessionId,
          cwd: workspace.cwd,
          mcpServers,
          modelId,
          // The permission mode is re-established by the autoDriven setMode block
          // below (identically to the session/new path), so it is not re-verified
          // here — matching how a fresh dispatch establishes it after handshake.
          onInitialize,
        });
        if (outcome.loaded) {
          record('lifecycle', { event: 'session-reloaded', sessionId: continueSessionId });
          await persistSession(continueSessionId);
        } else {
          // Fail forward to a fresh Session — never leave the Run session-less.
          record('lifecycle', { event: 'session-reload-declined', reason: outcome.reason, detail: outcome.detail });
          await driver.handshake({ cwd: workspace.cwd, mcpServers, modelId, onInitialize, onSessionCreated: persistSession });
        }
      } else {
        await driver.handshake({ cwd: workspace.cwd, mcpServers, modelId, onInitialize, onSessionCreated: persistSession });
      }

      // The session id is persisted; start tailing its native log (ADR 0010).
      this.tailer.start(run.id);
      // Arm the wall-clock Guardrail now the Run is genuinely executing.
      await armGuardrail();
      // Arm the hard tool-timeout watchdog alongside it (issue #131; a no-op
      // when the progress Guardrail is off). The stall detector is evaluated at
      // turn boundaries in the loop below, not on a timer.
      armToolTimeout();
      // Arm the token/cost spend Guardrail poll (issue #128; a no-op when
      // neither `tokens` nor `costUsd` is configured on the Run's frozen budget).
      await armSpendGuardrail();
      // Arm the Work Context lease heartbeat (issue #122).
      await armLeaseHeartbeat();

      // An afk Run executes unattended, so put the harness into an auto
      // permission mode: Claude's 'auto' classifier auto-approves safe tools
      // and only asks on genuinely risky ones (those still Escalate, below);
      // 'bypassPermissions' is the fallback for harnesses without 'auto'. Fail
      // closed if neither is offered, rather than prompt on every tool call and
      // Escalate immediately (issue #33 follow-up; pattern from ../starchart).
      if (autoDriven) {
        // Prefer a standard afk mode (Claude's 'auto' classifier, then
        // 'bypassPermissions'); failing that, a request-gated harness's
        // full-access mode (Codex's `danger-full-access`) — the ACP mode that
        // runs unattended without per-action approval. Codex advertises no
        // auto/bypass mode, so without forcing this it would Escalate on the
        // first privileged tool.
        const mode =
          AFK_PERMISSION_MODES.find((m) => driver.availableModes.includes(m)) ??
          afkFullAccessMode(task.harness, driver.availableModes);
        if (!mode) {
          // A request-gated harness that advertises no full-access mode still
          // governs unattended permissions through its spawn-time approval policy
          // plus the per-request handler in `onRequest` above. Any other harness
          // with no forceable mode fails closed rather than prompting on every
          // tool and Escalating immediately (issue #33 follow-up).
          if (!afkRequestGated(task.harness)) {
            throw new Error(
              `harness '${task.harness}' offers no unattended permission mode ` +
                `(need one of ${AFK_PERMISSION_MODES.join('/')}; available: ${driver.availableModes.join(', ') || 'none'})`,
            );
          }
        } else {
          await driver.setMode(mode);
          record('lifecycle', { event: 'mode_set', mode });
          // Unit C (#141): the Session's permission mode is only resolved here,
          // after the handshake — record it onto the durable Session row.
          // Best-effort for the same reason as the Session write above. (Native
          // Runs set no ACP mode, so their Session's permissionMode stays null —
          // an accurate "Harmonic set no mode", not a missing capture.)
          if (sessionRowId !== undefined) {
            try {
              await this.sessionStore.setPermissionMode(sessionRowId, mode, Date.now());
            } catch {
              /* best-effort; additive */
            }
          }
        }
      }

      // Harmonic settles a Run when its prompt turn resolves. But an afk agent
      // may end its turn just to park (waiting on CI, a watcher), ticket still
      // open — indistinguishable from "done" or "gave up". So for an auto-driven
      // Run the turn boundary is a checkpoint, not an exit: re-prompt to continue
      // until the agent signals finish/escalate, the ticket closes, or the
      // continue budget runs out (then the settle block below routes it to the
      // usual unresolved path). A native Run is otherwise single-turn — but
      // either kind takes a queued operator steer as an extra turn first (below).
      // A worktree-isolation Run's harness is spawned in — and must operate only
      // from — its worktree (`workspace.cwd`), never the canonical checkout the
      // Task's `workingDir` names. Surface the worktree as the `{workingDir}` the
      // prompt tells the agent, so a bare `cd $workingDir` merges there and cannot
      // commit onto the protected branch the canonical checkout is parked on.
      let promptText = autoDriven
        ? this.autoDrive!.prompt(task)
        : promptForTask({ ...task, workingDir: workspace.cwd }, this.getConfig().taskPrompt);
      // An operator continuation of a settled warm Session ({@link steerSettled}):
      // this Run bound the prior Session (session/load), so its first turn is just
      // the operator's follow-up message — the conversation already holds the task
      // context. Consumed once; corrective turns fall back to the normal feedback.
      const operatorSeed = this.pendingOperatorSeed.get(task.id);
      if (operatorSeed !== undefined) this.pendingOperatorSeed.delete(task.id);
      // A self-heal turn (issue #137) re-drives the same builder on its resumed
      // work, so append the verification failure as corrective feedback: fix the
      // cause, then finish, and the full suite reruns against the new candidate.
      // The condensed prior-Session seed (#311) is always the trailing section.
      let condensed: string | null = null;
      if (operatorSeed !== undefined && !healCtx) {
        promptText = `## Operator message\n\n${operatorSeed}`;
      } else if (healCtx) {
        promptText =
          `${promptText}\n\n## Previous attempt failed — fix required (self-heal ${healCtx.attempt})\n` +
          `Your previous attempt did not pass:\n${healCtx.reason}\n\n${healCtx.output}\n\n` +
          `Fix the cause so the full verification suite passes, then finish.`;
        condensed = healCtx.condensedContext ?? null;
      } else if (task.continuationChoice === 'condensed') {
        // A review reject the continuation rule routed to a fresh Session (#311)
        // or the operator's "start condensed" pick (#170): the feedback already
        // rides the Task prompt; seed the new Session with the prior one's
        // condensed context.
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
      // Tell the agent to query the worktree's own jCodeMunch repo (indexed above,
      // before the handshake) rather than resolving the repo by `.`.
      if (codeIndexRepoId) promptText = `${promptText}${codeIndexRepoGuidance(codeIndexRepoId)}`;
      // Persist the exact text sent so Task detail can show it on every Run —
      // native or mirrored — without re-deriving a template that may since have
      // changed (the "Prompt" tab reads this column). Steer/continue turns are
      // recorded as lifecycle events, not folded into this initial prompt.
      await this.runStore.update(run.id, { prompt: promptText });
      // Session setup can contain awaited persistence work. Keep steering
      // closed until the prompt request is ready to start, otherwise an
      // operator can receive 200 while ACP is idle and miss the running turn.
      active.steerable = true;
      let result = await driver.prompt([{ type: 'text', text: promptText }]);
      active.idle = true; // turn ended → parked
      // Steering + auto-drive continue loop. `attempt` counts only auto-drive
      // continue nudges, so operator steers never eat into the continue budget.
      for (let attempt = 1; !escalating && !stoppedShort; ) {
        if (active.externallySettled) break; // an operator settled the Run while it was parked
        if (active.escalateReason) {
          stoppedShort = `the agent stopped and asked for a human: ${active.escalateReason}`;
          break;
        }
        // Progress Guardrail (issue #131), evaluated here at the turn boundary —
        // the agent is parked, so the check and its one nudge never run
        // concurrently with an in-flight turn. First stall enqueues a single
        // nudge (drained as the next turn just below); a stall that survives that
        // nudge trips → Escalate, and we break to unwind through the
        // `externallySettled` guards.
        if (await checkProgressAtBoundary()) break;
        // A queued operator steer takes the next turn — for native and afk Runs
        // alike — ahead of any continue nudge, without spending continue budget.
        const steer = active.steerQueue.shift();
        if (steer !== undefined) {
          record('lifecycle', { event: 'steer_delivered', text: steer });
          active.idle = false; // a new turn is in flight — not parked, don't stop it
          result = await driver.prompt([{ type: 'text', text: steer }]);
          active.idle = true;
          continue; // re-check: more steers, then the agent's own finish/continue state
        }
        if (!autoDriven) break; // native Run with nothing queued → settle the single turn
        if (active.agentFinished) break; // explicit finish signal — the execution-complete signal (#139)
        if (attempt > this.autoDrive!.continueAttempts()) break; // budget spent → unresolved
        record('lifecycle', { event: 'continue', attempt });
        promptText = this.autoDrive!.continuePrompt(task);
        active.idle = false; // a new turn is in flight — not parked, don't stop it
        result = await driver.prompt([{ type: 'text', text: promptText }]);
        active.idle = true;
        attempt++;
      }
      // Leaving the loop to settle: no longer "parked awaiting work", so the
      // backstop must not race the settle below (it would skip Merge Fate).
      active.idle = false;
      // Close the steer gate synchronously so no new steer is accepted into a
      // Run that is committing to settle (steer() now 409s). A steer accepted
      // during the loop's final async settle-check — after the last shift(),
      // before this gate closed — is still queued; deliver it as a final turn
      // rather than dropping it. The gate is closed, so no new steer can extend
      // this drain and it terminates. Skip when the Run was already settled out
      // from under us, or is escalating.
      active.steerable = false;
      while (!active.externallySettled && !escalating && !stoppedShort && active.steerQueue.length > 0) {
        const steer = active.steerQueue.shift()!;
        record('lifecycle', { event: 'steer_delivered', text: steer });
        result = await driver.prompt([{ type: 'text', text: steer }]);
      }
      if (active.externallySettled) {
        // An operator already settled the Run and its Task; drop the harness
        // and stop — settling again would finish the Run twice.
        await finalize();
        return { kind: 'terminal' };
      }

      record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
      // A mirrored Run that ended without the `finish_task` signal — its continue
      // budget spent, or a single turn that never finished (a run "finished early
      // with no closure"). It is still put through the SAME verification gate as a
      // finished Run: the agent may have completed the work and simply not signalled
      // it, so we verify what it left rather than spending a corrective turn on a
      // possibly-good candidate. A candidate that verifies clean merges; one that
      // fails (or a run that left no new commit) fails closed through the normal
      // verify path below, exactly as a finished Run would.
      const afkUnresolved = autoDriven && !escalating && !stoppedShort && !active.agentFinished;
      if (afkUnresolved) record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal; verifying anyway' });
      let implementationHead: string | null = null;
      // The candidate is captured at implementation end so the verifiers review
      // the exact commit the agent left behind. An afk run that ended without
      // finish_task runs this too — its candidate is verified like any other.
      if (!escalating && !stoppedShort) {
        // A dirty implementation result gets one same-session reminder to
        // commit. This is corrective guidance within the current Attempt, not
        // a new Attempt or a retry budget charge. A direct Run must commit its
        // work onto the live branch for it to become the candidate (ADR-0046);
        // a context that was already dirty at start is left as the operator's.
        if (!workspace.startDirty && (await Git.isDirty(workspace.cwd).catch(() => false))) {
          const nudge = 'Your implementation left uncommitted changes. Commit the completed work now, then finish.';
          record('lifecycle', { event: 'commit-nudge' });
          active.idle = false;
          result = await driver.prompt([{ type: 'text', text: nudge }]);
          active.idle = true;
        }
        // The candidate is the commits the agent added on top of the start
        // commit. In direct mode those already sit on the live base branch
        // (ADR-0046); in worktree mode they are on the run branch. A run with no
        // new commit has no verifiable work and fails closed below.
        const [head, base] = await Promise.all([
          Git.revParse(workspace.cwd, 'HEAD').catch(() => null),
          workspace.baseRev ? Git.revParse(workspace.cwd, workspace.baseRev).catch(() => null) : Promise.resolve(null),
        ]);
        if (head && head !== base) {
          implementationHead = head;
          await this.runStore.update(run.id, { candidateOid: head });
        }
      }
      await finalize();
      const usage = await this.collectUsageSafe(task, run, harness, workspace, result);
      // The continuation gate's context-fill fallback (decideContinuation) reads
      // this once the run has settled and its live tailer is gone. Seed it from
      // the parsed tree's last-turn footprint (usage.contextTokens), NOT the ACP
      // aggregate — the aggregate over-counts multi-round-trip turns and made the
      // gate see impossible >100% fill, refusing to reuse a warm session (#…).
      if (usage?.contextTokens != null) this.lastTurnContextTokens.set(run.id, usage.contextTokens);
      this.noteModelMismatch(task, usage, record);
      const patch = { stopReason: result.stopReason ?? null, usage: usage ? JSON.stringify(usage) : null };
      if (escalating) {
        record('lifecycle', { event: 'escalated', reason: escalating });
        await this.settleEscalated(task, run, escalating, patch);
      } else if (stoppedShort) {
        record('lifecycle', { event: 'stopped-short', reason: stoppedShort });
        return { kind: 'actionable-fail', reason: stoppedShort, output: '' };
      } else {
        // Verification gate (issue #135, ADR-0021, reliability-design Unit B):
        // agent-finish begins validation — it does not settle the Run (#114).
        // Enter `verifying` and run the configured verifiers against the branch
        // head. A pass lets the Run proceed to merging. Any non-`proceed` verdict
        // with a candidate hands the failed Attempt up to the `drive` loop for a
        // bounded corrective turn (ADR-0041); an inconclusive with NO candidate
        // Escalates in place with its cause — so broken work never merges.
        await advanceTask('verifying');
        record('lifecycle', { event: 'phase', phase: 'verifying' });
        const { decision, ran: verifierRan } = await this.runVerification(
          task,
          run,
          implementationHead,
          active.verifyAbort.signal,
          record,
          parent,
        );
        // Verification can take up to the command's timeout (minutes). Re-check
        // the two ways the Run may have been settled out from under us during
        // that window before acting on the verdict:
        // - Process/server shutdown aborted the verifier (→ inconclusive here).
        //   That is not a run failure: leave the Run `running` for boot
        //   reconciliation to record interrupted, exactly as the catch block
        //   below does for a SIGKILLed harness — don't Escalate on shutdown timing.
        if (this.shuttingDown) return { kind: 'terminal' };
        // - The poll Escalated a prematurely-closed ticket, or an operator
        //   cancelled: the Run is already terminal, so settling again (or
        //   parking) would finish it twice / un-terminal it. Drop the harness and stop.
        if (active.externallySettled) {
          await finalize();
          return { kind: 'terminal' };
        }
        if (decision.outcome === 'block') {
          // Actionable fail (issue #137): do NOT settle — hand the failure up to
          // the unified Attempt loop with the failing verifier's output as
          // corrective feedback. `finalize()` already committed this turn's work
          // onto the Run's branch and the candidate ref holds it, so the
          // corrective turn resumes and fixes it.
          return await this.verificationFailTurn(run, decision, record);
        } else if (decision.outcome !== 'proceed') {
          // `escalate` = inconclusive (infra doubt: missing command, crashed or
          // malformed verifier, absent candidate). With no candidate there is
          // nothing a corrective turn could fix — Escalate in place (trigger 3)
          // so the Task surfaces with a null candidate (Accept 409s on it). With
          // a candidate, infra doubt consumes the same bounded Attempt loop as
          // an actionable fail.
          if ((await this.runStore.get(run.id)).candidateOid == null) {
            const reason = `verification ${decision.outcome}: ${decision.reason}`;
            record('lifecycle', { event: 'escalated', reason });
            await this.settleEscalated(task, run, reason, patch);
            return { kind: 'terminal' };
          }
          return await this.verificationFailTurn(run, decision, record);
        } else {
          // An afk Run that ended WITHOUT finish_task merges only on an AFFIRMATIVE
          // verifier pass — a real verifier ran and passed against a real candidate.
          // A vacuous `proceed` (no verifiers configured, so nothing actually
          // affirmed the work) or a missing candidate is NOT enough to complete an
          // unsignalled Run: hand it up to the unified Attempt loop as an actionable
          // fail so it takes another bounded Attempt and Escalates at the cap —
          // preserving #139's guarantee that unsignalled work never silently merges
          // unless a verifier vouched for it. A finished Run (finish_task) merges on
          // `proceed` as before; and an early-finished Run WHOSE verifiers pass now
          // merges too — the point of verifying an early-finished Run's work.
          if (afkUnresolved && (!verifierRan || (await this.runStore.get(run.id)).candidateOid == null)) {
            record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal and no verifier vouched for the work' });
            return { kind: 'actionable-fail', reason: 'run ended without an execution-complete (finish_task) signal', output: '' };
          }
          // Harmonic merges every passing Run itself — there is no human gate
          // (ADR-0041) — so the merging freshness gate runs first: the branch
          // must still sit at its verified tip and that tip must contain the
          // base's current tip. A moved base re-enters Rebase → Verification on
          // this same Attempt (no counter increment, no implementation turn)
          // before merging. The diffstat is snapshotted before the merge
          // fast-forwards the base onto the branch tip (issue #36).
          const diff = await this.diffSnapshotFor(task, run.id);
          const gate = await this.freshenForMerge(task, run, workspace, attemptNumber, autoDriven, active.verifyAbort.signal, record, parent);
          if (gate.kind === 'turn') return gate.outcome;
          if (gate.kind === 'escalate') {
            record('lifecycle', { event: 'escalated', reason: gate.reason });
            await this.settleEscalated(task, run, gate.reason, patch);
            return { kind: 'terminal' };
          }
          if (!autoDriven) {
            // A native worktree Run's branch was merged by the gate (SHA-asserted,
            // fast-forward-only); a native direct Run's commits already sit on
            // the live branch. Nothing more to merge: settle done.
            await advanceTask('merging');
            record('lifecycle', { event: 'phase', phase: 'merging' });
            await this.settleAutoCompleted(task, run, { ...patch, ...diff });
            return { kind: 'terminal' };
          }
          // A mirrored Run: executing → validating → verifying → merging →
          // terminal. A worktree auto-merge Run's branch was merged by the gate
          // above (SHA-asserted, fast-forward-only); a direct Run's verified
          // commits already sit on the live base branch (ADR-0046), so there is
          // nothing to merge. Either way the Merge Fate then applies the rest in
          // onCompleted — open a PR, or (auto-merge) close the ticket — Harmonic
          // owns the close, only after verify + merge (#139). A fate that can't be
          // applied (PR that can't be created, ticket close that fails)
          // Escalates; the ticket is not closed.
          //
          // Parallel-Epic member merge (issue #163): a worktree auto-merge Run
          // whose base is an Epic integration branch (`epic/<ref>`) merges through
          // the single-writer merge train — a fast-forward of the verified tip,
          // ordered per integration branch — instead of `onCompleted`'s unordered
          // plain merge. The gate above already submitted it (and re-entered
          // rebase+verify on a `stale` outcome), so `gate.train` is its result.
          if (gate.train) {
            if (gate.train.status === 'escalated') {
              // The coordinator's `escalate` callback (→ settleEscalatedForMember)
              // already settled the Run; only record + stop here (no double-settle).
              record('lifecycle', { event: 'escalated', reason: gate.train.reason });
              return { kind: 'terminal' };
            }
            // merged | already-merged: the work is on the integration branch.
            // Harmonic still owns the ticket close (#139) — the train replaced the
            // merge, not the close.
            if (!(await this.autoDrive!.closeCompleted(task))) {
              record('lifecycle', { event: 'escalated', reason: 'ticket close failed after merge-train merge' });
              await this.settleEscalated(task, run, 'ticket close failed after merge-train merge', patch);
            } else {
              await advanceTask('merging');
              record('lifecycle', { event: 'phase', phase: 'merging' });
              await this.settleAutoCompleted(task, run, { ...patch, ...diff });
            }
            return { kind: 'terminal' };
          }

          const outcome = await this.autoDrive!.onCompleted(task, await this.runStore.get(run.id));
          if (outcome === 'escalate') {
            record('lifecycle', { event: 'escalated', reason: 'merge fate could not be applied' });
            await this.settleEscalated(task, run, 'merge fate could not be applied', patch);
          } else {
            // The Merge Fate is applied → record `merging`, then settle
            // terminal (the coordinator marks the Run `phase:'terminal'`).
            await advanceTask('merging');
            record('lifecycle', { event: 'phase', phase: 'merging' });
            await this.settleAutoCompleted(task, run, { ...patch, ...diff });
          }
        }
      }
      // The turn settled above (escalate / merge) — a terminal outcome; the
      // corrective loop stops. Only the fail branches return `actionable-fail`, earlier.
      return { kind: 'terminal' };
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      // Let stderr finish flushing (the process has exited, so 'end' is
      // imminent) before reading its tail, capped so a hang can't wait.
      await Promise.race([stderrFlushed, new Promise((r) => setTimeout(r, 500))]);
      const tail = stderrTail.trim();
      const reason = tail ? `${base}\n\nharness stderr:\n${tail}` : base;
      await finalize();
      // The poll may have stopped a parked agent on a prematurely-closed ticket;
      // that Run is already settled Escalated, so don't re-settle it as failed.
      if (active.externallySettled) return { kind: 'terminal' };
      // Process/server shutdown SIGKILLed the harness — this is not a run
      // failure. Leave the Run `running` so boot reconciliation settles it
      // interrupted (process-death), not a spurious "harness exited" failure.
      if (this.shuttingDown) return { kind: 'terminal' };
      const usage = await this.collectUsageSafe(task, run, harness, workspace, undefined);
      this.noteModelMismatch(task, usage, record);
      const patch = { usage: usage ? JSON.stringify(usage) : null };
      if (escalating) {
        record('lifecycle', { event: 'escalated', reason: escalating });
        await this.settleEscalated(task, run, escalating, patch);
        return { kind: 'terminal' };
      }
      // An operator cancel/force-complete already settled this Run terminal and
      // SIGKILLed the harness: the exit we caught is that kill, not a failure —
      // never a corrective attempt on a Run that is over.
      if ((await this.runStore.get(run.id)).state !== 'running') {
        await this.runStore.update(run.id, patch);
        return { kind: 'terminal' };
      }
      // An implementation or harness failure is a failed Attempt too. Keep it
      // inside `drive` so mirrored and native tickets share the cap.
      await this.runStore.update(run.id, patch);
      return { kind: 'actionable-fail', reason, output: '' };
    } finally {
      // Disarm the wall-clock watchdog: `driveOnce` is returning, so the Run is
      // leaving every execution phase (merging or settled) —
      // and time past this point must not count against the execution budget.
      if (guardrailTimer) clearTimeout(guardrailTimer);
      if (toolTimeoutTimer) clearInterval(toolTimeoutTimer);
      if (spendTimer) clearInterval(spendTimer);
      if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
      driver.fail(new Error('run finished'));
      driver.dispose();
      this.active.delete(run.id);
      await finalize();
    }
  }

  /**
   * The run's incremental session-log reader (#217), created lazily once a
   * session id exists. claude tails only newly-appended bytes each tick; the
   * other harnesses fall back to a whole-file `parse()` per tick
   * (`wholeFileReader`). null before a session id, or for a harness with no
   * Usage Collector. Reused across ticks so the byte cursor persists.
   */
  private async readerFor(runId: number): Promise<SessionTailReader | null> {
    const existing = this.readers.get(runId);
    if (existing) return existing;
    const active = this.active.get(runId);
    if (!active) return null;
    const sessionId = (await this.runStore.get(runId)).sessionId;
    if (!sessionId) return null;
    const collector = adapterFor(active.harnessId).usage;
    if (!collector) return null;
    const input = { sessionLogDir: active.harness.sessionLogDir, cwd: active.cwd, sessionId };
    const reader = collector.createTailReader?.(input) ?? wholeFileReader(collector, input);
    this.readers.set(runId, reader);
    return reader;
  }

  /** Claude can create its JSONL just after `session/new`; retry a few times
   * without holding up the Run, then leave the Session transcript-less. */
  private async captureTranscriptPath(input: {
    sessionId: string;
    sessionRowId: number;
    sessionLogDir: string | undefined;
    transcriptResolver: (input: { sessionLogDir?: string | undefined; sessionId: string }) => Promise<string | null>;
  }): Promise<void> {
    for (const delayMs of [100, 500, 2_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const transcriptPath = await input.transcriptResolver({ sessionLogDir: input.sessionLogDir, sessionId: input.sessionId }).catch(
        () => null,
      );
      if (!transcriptPath) continue;
      await this.sessionStore.setTranscriptPath(input.sessionRowId, transcriptPath, Date.now()).catch(() => {});
      return;
    }
  }

  /**
   * Resolve a Session's native transcript path on demand and persist it — the
   * read-path counterpart to {@link captureTranscriptPath}. The eager capture at
   * dispatch races the harness writing its `${sessionId}.jsonl` and gives up after
   * a few hundred ms; anything that delays the first turn (e.g. pre-turn work) can
   * push the file past that window and leave `transcriptPath` null forever. By the
   * time a reader asks for the transcript the file exists, so resolving here
   * removes the dependence on that startup race entirely and self-heals a Session
   * the eager pass missed. Returns the stored or freshly-resolved path, or null
   * when it still cannot be resolved (unknown harness, no resolver, file absent).
   */
  async ensureSessionTranscript(sessionRowId: number): Promise<string | null> {
    const session = await this.sessionStore.get(sessionRowId).catch(() => null);
    if (!session) return null;
    if (session.transcriptPath) return session.transcriptPath;
    const resolver = adapterFor(session.harness).usage?.resolveTranscriptPath;
    if (!resolver) return null;
    const harnesses = this.getConfig().harnesses;
    const sessionLogDir = harnesses[session.harness as keyof typeof harnesses]?.sessionLogDir;
    const transcriptPath = await resolver({ sessionLogDir, sessionId: session.harnessSessionId }).catch(() => null);
    if (!transcriptPath) return null;
    await this.sessionStore.setTranscriptPath(sessionRowId, transcriptPath, Date.now()).catch(() => {});
    return transcriptPath;
  }

  /** The critic equivalent of {@link captureTranscriptPath}: the harness may
   * not have flushed its `${sessionId}.jsonl` by the time the critic turn ends
   * and the attempt is appended (root cause of a persistently null critic
   * transcript). Retry a few times off the hot path, then fill the attempt's
   * transcript locator so the operator's on-demand critic-session log resolves. */
  private async captureCriticTranscriptPath(input: {
    attemptId: number;
    sessionId: string;
    harnessId: string;
    sessionLogDir: string | undefined;
  }): Promise<void> {
    const resolver = adapterFor(input.harnessId).usage?.resolveTranscriptPath;
    if (!resolver) return;
    for (const delayMs of [100, 500, 2_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      const transcriptPath = await resolver({ sessionLogDir: input.sessionLogDir, sessionId: input.sessionId }).catch(() => null);
      if (!transcriptPath) continue;
      await this.verificationAttempts.setTranscriptPath(input.attemptId, transcriptPath).catch(() => {});
      return;
    }
  }

  /**
   * The live snapshot for a run's tailer (ADR 0010): advance the incremental
   * reader (#217 — off the event loop, only newly-appended bytes) and decorate
   * its parse with the event-derived tool tally + activity line. Called only by
   * the tailer tick; the on-demand callers read `latestSnapshot`.
   */
  private async sampleSnapshot(runId: number): Promise<RunUsageSnapshot | null> {
    const reader = await this.readerFor(runId);
    if (!reader) return null;
    return await this.decorateSnapshot(runId, await reader.sample());
  }

  /**
   * The freshest snapshot the tailer has already sampled, with no I/O — for the
   * on-demand callers (Activity snapshot #51, spend guard #128) that ride the
   * tailer's ~1s cadence instead of re-parsing the whole log themselves (#217).
   * null before the tailer's first sample.
   */
  private async latestSnapshot(runId: number): Promise<RunUsageSnapshot | null> {
    return await this.decorateSnapshot(runId, this.readers.get(runId)?.latest() ?? null);
  }

  /**
   * `parse`/the reader yield the per-model roll-up and tree but no tool tally
   * (computed from the in-memory ACP rollup) — so the live "· N tools" figure the Board
   * ticks off `run_usage` (issue #100) would be stuck at zero. Tally the run's
   * rollup here, and fold the per-agent breakdown in for parity with the
   * settle-time Usage. The current-activity line comes off the active Run.
   */
  private async decorateSnapshot(runId: number, parsed: ParsedSession | null): Promise<RunUsageSnapshot | null> {
    if (!parsed) return null;
    const active = this.active.get(runId);
    const toolCalls = Object.fromEntries(this.toolCallTotals.get(runId) ?? (await this.runStore.listToolCalls(runId)));
    const agents = agentsFromTree(parsed.tree);
    const usage: RunUsage = { ...parsed.usage, toolCalls, ...(Object.keys(agents).length > 0 ? { agents } : {}) };
    return { usage, contextTokens: parsed.tree.contextTokens, activity: active?.activity ?? null, tree: parsed.tree };
  }

  /** Usage is decoration on a finished run — never let it fail the run. */
  private async collectUsageSafe(
    task: TaskRow,
    run: RunRow,
    harness: HarnessConfig,
    workspace: Workspace,
    promptResult: { stopReason?: string; usage?: Record<string, unknown>; _meta?: unknown } | undefined,
  ): Promise<RunUsage | null> {
    try {
      const usage = await collectUsageWithRetry({
        harnessId: task.harness,
        harness,
        cwd: workspace.cwd,
        sessionId: (await this.runStore.get(run.id)).sessionId,
        promptResult,
      });
      if (!usage) return null;
      // `usage.contextTokens` is the parsed tree's last-turn footprint (see
      // collectUsage) — the true window fill; never re-derive it from the ACP
      // aggregate here (that sums every round-trip and reads past the window).
      return {
        ...usage,
        toolCalls: Object.fromEntries(this.toolCallTotals.get(run.id) ?? (await this.runStore.listToolCalls(run.id))),
      };
    } catch {
      return null;
    }
  }

  /**
   * Q7: the model setting we show must be real. When usage attribution
   * proves the harness ran something other than the task's pin, say so
   * on the run rather than letting the lie stand.
   */
  private noteModelMismatch(
    task: TaskRow,
    usage: RunUsage | null,
    record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void,
  ): void {
    const observed = usage ? observedModelMismatch(task.model, usage.models) : null;
    if (observed) record('lifecycle', { event: 'model_mismatch', expected: task.model, observed });
  }

  /**
   * Boot-time healing for the same race: finished runs whose stored
   * usage has no per-model split get one more read of the (now settled)
   * session log. Stored ACP totals win over re-derived ones.
   */
  async backfillUsage(): Promise<void> {
    const config = this.getConfig();
    for (const run of await this.runStore.listUsageBackfillCandidates()) {
      try {
        const task = await this.taskService.get(run.taskId);
        const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
        if (!harness) continue;
        // Worktree runs executed (and logged) under the worktree path;
        // the directory is gone but the log slug derives from the string. A
        // direct run has no branch and executed in the live working dir.
        const cwd = run.branch ? join(this.worktreesDir, `run-${run.id}`) : task.workingDir;
        const fresh = collectUsage({
          harnessId: task.harness,
          harness,
          cwd,
          sessionId: run.sessionId,
        });
        if (!fresh || Object.keys(fresh.models).length === 0) continue;
        fresh.toolCalls = Object.fromEntries(await this.runStore.listToolCalls(run.id));
        const stored = run.usage ? (JSON.parse(run.usage) as RunUsage) : null;
        const healed: RunUsage = stored?.totals
          ? { ...fresh, totals: stored.totals, source: 'combined' }
          : fresh;
        await this.runStore.update(run.id, { usage: JSON.stringify(healed) });
      } catch {
        // Healing is best-effort; the run keeps its stored usage.
      }
    }
    await this.runStore.backfillCosts(resolvePrices(config.prices));
  }

  /** The settled worktree diff's exact revisions and stat. Git metadata is
   * decorative, so a failure leaves all three fields null. */
  private async diffSnapshotFor(
    task: TaskRow,
    runId: number,
  ): Promise<Pick<RunRow, 'stat' | 'diffBaseOid' | 'diffHeadOid'>> {
    const run = await this.runStore.get(runId);
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
    } catch {
      return { stat: null, diffBaseOid: null, diffHeadOid: null };
    }
  }

  /**
   * The Runner's settle entry point (issue #113/#114): delegate to the shared
   * {@link RunSettleCoordinator}, which appends the ending-signal `run_fact` and
   * replays the winning disposition by fixed precedence. Extracted so the
   * operator Accept merges through the *same* coordinator, with identical
   * race-safety, rather than racing the Runner around the Run row.
   */
  private async coordinateSettle(
    task: TaskRow,
    run: RunRow,
    type: RunFactType,
    projection: SettleProjection,
    patch: Partial<RunRow> = {},
  ): Promise<void> {
    await this.settleCoordinator.settle(task, run, type, projection, patch);
    const attempt = await this.attempts.getForTaskNumber(task.id, run.attempt);
    if (attempt) {
      const timelineTasks = await this.attempts.listTasks(attempt.id);
      const now = Date.now();
      await Promise.all(timelineTasks.filter((timelineTask) => timelineTask.state === 'running').map((timelineTask) =>
        this.attempts.updateTask(timelineTask.id, {
          state: projection.runState === 'completed' ? 'passed' : 'failed',
          endedAt: now,
          verdict: projection.runState === 'completed' ? 'pass' : 'fail',
        }),
      ));
      // A failed verification has already closed its Attempt with verifier
      // feedback before requesting escalation. Preserve that terminal record;
      // only terminal paths that did not already close an Attempt decide its
      // final state here.
      if (attempt.state === 'running') {
        await this.attempts.finish(attempt.id, projection.taskAction === 'escalate' ? 'escalated' : projection.runState === 'completed' ? 'passed' : 'failed', now);
      }
    }
    await this.finishRunOperation(run.id);
  }

  /** A verified and merged Run: the ticket is done. Only settles a still-working Task — a racing cancel wins. */
  private async settleAutoCompleted(task: TaskRow, run: RunRow, patch: Partial<RunRow>): Promise<void> {
    await this.coordinateSettle(
      task,
      run,
      'agent-finish/unresolved',
      { runState: 'completed', taskAction: 'done', reason: null },
      patch,
    );
  }

  /** ADR-0041's one escalation surface: Run failed, Task escalated with the trigger's reason. */
  private async settleEscalated(task: TaskRow, run: RunRow, reason: string, patch: Partial<RunRow>): Promise<void> {
    await this.coordinateSettle(task, run, 'escalate', {
      runState: 'failed',
      taskAction: 'escalate',
      reason: `escalated to human: ${reason}`,
    }, patch);
  }

  private kill(active: ActiveRun): void {
    try {
      if (active.child.exitCode === null && !active.child.killed) active.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
