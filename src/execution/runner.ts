import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { snapshotCandidate } from './candidate.js';
import {
  detachForDirectRun,
  captureDirectHead,
  restoreLiveCheckout,
  rematerializeCandidate,
} from './execution-isolation.js';
import { adapterFor, adapterVersion } from './harness/adapter.js';
import { collectUsage, collectUsageWithRetry, observedModelMismatch, activityLine, totalTokensOf, type RunUsage, type RunUsageSnapshot } from './usage.js';
import { LiveUsageTailer, type TailerCadence } from './live-usage-tailer.js';
import { promptForTask } from './run-prompt.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, RunRow, WorkspaceRow, SessionRow } from '../db/schema.js';
import { AcpDriver, type AcpInitializeResult } from '../acp/driver.js';
import { SessionStore } from '../domain/sessions.js';
import { assessResumeEligibility, sessionFacts, type ResumeEnvironment } from '../domain/session-resume.js';
import {
  planSessionContinuation,
  sessionWarmthFacts,
  type ContinuationTrigger,
} from '../domain/session-continuation.js';
import { repoKey } from './repo-lock.js';
import { DomainError } from '../domain/errors.js';
import type { RunStore, PersistedRunEvent, RunGuardrailSnapshot } from '../domain/runs.js';
import { RunFactStore } from '../domain/run-facts.js';
import { LandingJournalStore } from '../domain/landing-journal.js';
import type { SettleProjection, SettleTaskAction } from '../domain/run-coordinator.js';
import { RunSettleCoordinator } from '../domain/run-settle.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import { phasePath, type RunPhase, type ReviewGate } from '../domain/run-phases.js';
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
import {
  toolTimeoutBudgetMs,
  toolTimeoutTrip,
  formatToolTimeoutReason,
} from '../domain/guardrail-tool-timeout.js';
import { TurnQueueStore } from '../domain/turn-queue-store.js';
import { runCommandVerifier, commandAttemptToInput } from '../verification/command-verifier.js';
import { runCritic, criticAttemptToInput, type CriticHarnessDrive } from '../verification/critic.js';
import { combineVerdicts, type VerificationDecision, type VerifierVerdict } from '../verification/combine.js';
import { resolvePrices, costOfUsages, type PriceTable } from './pricing.js';
import { workContextKey } from '../domain/work-context-key.js';
import type { WorkContextLeaseStore } from '../domain/work-context-leases.js';
import {
  evaluateAdmission,
  AdmissionRejected,
  type StartStateProbe,
  type RunStartState,
} from '../domain/run-start-state.js';
import {
  classifyBranchOutcome,
  planDeterministicRecovery,
  evaluateReMergeResult,
  type BranchContractObservation,
  type BranchClassification,
} from '../domain/branch-recovery.js';
import { parseRefLines, diffRefs } from '../domain/branch-observation.js';
import { landBranch } from './branch-landing.js';
import { parseIntegrationBranch } from './epic-integration.js';
import type { MergeTrainCoordinator, MergeTrainMember } from './merge-train-coordinator.js';
import type { Db } from '../db/index.js';

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

/**
 * Default review SLA (issue #114): how long a native Run may sit parked in
 * `phase:'review'` awaiting a human accept/reject before the review-SLA sweep
 * settles it to a terminal disposition. The coordination spine ships no
 * operator-facing config (reliability-design §0, "the spine is infrastructure";
 * a per-Workspace review SLA is Unit A's setting), so the deadline is this
 * internal default until that lands. Seven days: long enough that a real review
 * queue never trips it, short enough that an abandoned review can't wedge a Work
 * Context lease forever. */
const REVIEW_SLA_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunnerEvents {
  /** Fired after every run event is persisted (live streaming hook). */
  onRunEvent?: (event: PersistedRunEvent) => void;
  /** Fired whenever a run reaches a terminal state. */
  onRunFinished?: (run: RunRow) => void;
  /** Fired ~1s while a run tails its native log (ADR 0010: `run_usage`). */
  onRunUsage?: (payload: { runId: number; snapshot: RunUsageSnapshot }) => void;
}

export interface RunnerOptions {
  events?: RunnerEvents;
  /** Where temporary worktrees live; per-run subdirectories. */
  worktreesDir?: string;
  /** Mints/revokes the per-run scoped API key injected into the harness. */
  keys?: {
    mint: (runId: number) => string;
    revoke: (runId: number) => void;
  };
  /** Auto-drive collaborator for afk mirrored Tasks (issue #33); absent on a native-only server. */
  autoDrive?: AutoDrive;
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
  ) =>
    | Pick<
        WorkspaceRow,
        | 'guardrailBudget'
        | 'guardrailProgress'
        | 'verificationCommand'
        | 'verificationCritic'
        | 'verificationAutoAccept'
      >
    | undefined;
  /** Lands a native auto-accept Run (issue #138): the verifier passed and the
   * resolved verifier config sets auto-accept, so Harmonic lands the result via
   * the same journaled LandingCoordinator the human Accept uses (#115), skipping
   * the review gate. Absent → auto-accept never fires (Runs park for review).
   * Returns ok:false on a landing failure (e.g. a merge conflict from a moved
   * base) — the Runner then degrades to the human gate rather than settling. */
  autoAcceptLand?: (
    task: TaskRow,
    run: RunRow,
    patch: Partial<RunRow>,
  ) => Promise<{ ok: boolean; detail?: string | undefined }>;
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
   * {@link MergeTrainCoordinator} an Epic member's Run lands through, in place of
   * the direct auto-merge path. Absent → members fall back to the plain
   * `AutoDrive.onCompleted` merge (pre-#163 behaviour). Its `dispatchHeal`/
   * `escalate` are wired (in app.ts) to {@link Runner.enqueueReMergeForMember} /
   * {@link Runner.settleEscalatedForMember}, so the coordinator must be shared
   * with the Runner that owns those callbacks. */
  mergeTrain?: MergeTrainCoordinator;
}

interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
  /** The validated base the candidate snapshot is parented on (issue #134):
   * the base branch (worktree mode) or the start `HEAD` OID (direct mode).
   * Unset when the working dir is not a git repo, so no candidate is built. */
  baseRev?: string;
  /** Whether a direct-mode context was already dirty at Run start — captured
   * before the agent touches it, so a dirty/concurrently-editable context is
   * not snapshotted (its pre-existing edits would otherwise be swept in). */
  startDirty?: boolean;
  /**
   * Set for an afk **direct** Run whose HEAD was detached onto a private
   * Harmonic ref at start (issue #152): the branch it was parked on and the
   * start commit. Its presence tells `finalizeWorkspace` to restore the live
   * target checkout coherently at settle (re-attach HEAD to `startBranch`,
   * sweep the agent's changes — already frozen in the candidate). Unset for
   * worktree mode, native direct Runs, and non-git contexts. */
  directIsolation?: { startBranch: string; startCommit: string };
  /**
   * Set when the `validating` branch-contract check (issue #151) found an
   * ambiguous git outcome and Escalated. Tells `finalizeWorkspace` to **retain**
   * the worktree/refs as-is (skip the direct-mode checkout restore / worktree
   * teardown) so the operator has the evidence to disposition the violation —
   * reliability-design Unit D "worktree/refs retained until operator disposition".
   */
  retainForBranchViolation?: boolean;
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
   * True while the Run can still accept operator steers. Set false
   * synchronously the instant {@link Runner.drive} commits to leaving the
   * steering loop to settle — before any settle `await`. Because both this
   * assignment and {@link Runner.steer} run synchronously (no await between
   * the loop exit and the gate close), a steer is either already in the queue
   * when the loop's last `shift()` runs (delivered) or arrives after the gate
   * closes (cleanly rejected 409) — never silently accepted then dropped.
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
 * Spawns a task's harness, drives it over ACP, persists every
 * session/update as a run event, and settles the task's state from the
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
}

/**
 * The corrective context threaded into a bounded agent re-merge turn (issue #155,
 * reliability-design Unit D). When a Run's git outcome is *ambiguous* and
 * deterministic recovery (#154) cannot safely land, Harmonic asks the agent — in
 * exactly ONE corrective turn — to re-home its work cleanly; `reason`/`detail`
 * surface the branch-contract violation as feedback. `allowedTree` is the tree of
 * the pre-re-merge frozen candidate — the recorded artifact the corrective
 * result must reproduce to be within the allowed set (judged by
 * {@link evaluateReMergeResult}). Distinct from {@link HealContext}: a re-merge
 * turn is bounded to one, never self-heals afterward, and lands only on an
 * allowed-set match, else Escalates with no second mutating turn.
 */
interface ReMergeContext {
  reason: string;
  detail: string;
  /** The recorded-artifact tree the #155 allowed-set gate ({@link landReMerge})
   * checks the corrective result against. Absent for a merge-train member's
   * corrective turn (issue #163): that turn re-lands through
   * {@link MergeTrainCoordinator.onHealComplete}, whose own rebase→ff is the
   * gate, so no allowed-set tree is captured. */
  allowedTree?: string;
}

/**
 * The outcome of one builder turn ({@link Runner.driveOnce}, issue #137).
 * `actionable-fail` — a `block` verdict — is the SOLE heal-eligible result: the
 * turn deliberately did not settle, handing the failure up to the heal loop.
 * Every other ending (proceed→land/review, inconclusive→escalate, unresolved,
 * error, operator-settled) is `terminal`: the Run was already settled or parked
 * inside the turn, and the loop stops.
 */
type TurnOutcome =
  | { kind: 'terminal' }
  | { kind: 'actionable-fail'; reason: string; output: string }
  // A first-turn ambiguous branch outcome that is eligible for a bounded agent
  // re-merge (issue #155): the turn deliberately did not settle, handing the
  // decision up to the {@link Runner.drive} loop to dispatch exactly ONE
  // corrective re-merge turn. `reason`/`detail` are the branch-contract violation.
  | { kind: 'remerge-needed'; reason: string; detail: string }
  // An Epic member's merge-train land hit a rebase conflict and the coordinator
  // dispatched its one bounded corrective turn (issue #163): the turn deliberately
  // did not settle, handing the decision up to {@link Runner.drive} to run exactly
  // ONE corrective turn whose land re-enters the train via `onHealComplete`. The
  // coordinator owns the one-heal-then-escalate bound (its `healAttempted` set);
  // `detail` is the rebase conflict surfaced to that turn as feedback.
  | { kind: 'merge-train-heal'; detail: string };

export class Runner {
  private active = new Map<number, ActiveRun>(); // by run id
  /** Set once {@link shutdown} kills the harnesses on process/server close, so a
   * drive loop reacting to its SIGKILLed harness leaves the Run `running` for
   * boot reconciliation to record as interrupted, rather than settling it a
   * spurious `failed` (issue #113). */
  private shuttingDown = false;

  private readonly events: RunnerEvents;
  private readonly worktreesDir: string;
  private readonly keys: RunnerOptions['keys'];
  private readonly autoDrive: AutoDrive | undefined;
  private readonly getWorkspace: RunnerOptions['getWorkspace'];
  private readonly autoAcceptLand: RunnerOptions['autoAcceptLand'];
  /** The single-writer merge train an Epic member's Run lands through (issue
   * #163); undefined on a server with no parallel-Epic execution. */
  private readonly mergeTrain: MergeTrainCoordinator | undefined;
  /** Bridges the merge train's out-of-band heal dispatch to the in-process
   * `drive` loop (issue #163): {@link enqueueReMergeForMember} (bound to the
   * coordinator's `dispatchHeal`) records the corrective turn's queue row here,
   * keyed by runId, so `drive` can settle that exact row once it has run the
   * turn. In-memory only — the queue row itself is the durable record. */
  private readonly pendingMemberReMerge = new Map<number, number>();
  /** Injectable agent-critic drive (issue #164); undefined → `runCritic` falls
   * back to the real `createAcpCriticDrive`. */
  private readonly criticDrive: RunnerOptions['criticDrive'];
  private readonly runFacts: RunFactStore;
  /** The Verification attempt log (issue #135/#136): every command/critic
   * verifier invocation against a Run's frozen candidate is appended here. */
  private readonly verificationAttempts: VerificationAttemptStore;
  /** The structured Guardrail-trip observability log (issue #127, ADR-0019):
   * every wall-clock (later token/cost) trip is appended here, and the amber
   * Escalation card reason derives from it. */
  private readonly guardrailEvents: GuardrailEventStore;
  /** The per-Session turn queue (issue #116): a bounded self-heal (issue #137)
   * records its corrective turn here, single-flight per Session, before the
   * builder re-drives it. */
  private readonly turnQueue: TurnQueueStore;
  /** The Execution Chain store (issue #129, reliability-design Unit A): mints /
   * resolves the persisted `execution_chains` identity a Run belongs to, so a
   * cumulative token/cost budget is charged across every Run that continues one
   * line of work (reattempt / mirrored retry / crash-resume / self-heal) and a
   * retry cannot reset the counter to bypass the ceiling. */
  private readonly chainStore: ExecutionChainStore;
  /** The durable Session store (issue #141, reliability-design Unit C): every
   * dispatch records a Session capturing the harness's `initialize`
   * capabilities alongside the Run, without changing Run behaviour. */
  private readonly sessionStore: SessionStore;
  /** The shared terminal-disposition coordinator (issue #113/#114): every Run
   * settle — drive-loop, operator cancel/complete, review-parked — funnels here
   * so the winning disposition is decided by precedence, once. */
  private readonly settleCoordinator: RunSettleCoordinator;
  private readonly tailer: LiveUsageTailer;
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
    private readonly db: Db,
    private readonly getConfig: () => AppConfig,
    options: RunnerOptions = {},
  ) {
    this.events = options.events ?? {};
    this.worktreesDir = options.worktreesDir ?? join(tmpdir(), 'harmonic-worktrees');
    this.keys = options.keys;
    this.autoDrive = options.autoDrive;
    this.getWorkspace = options.getWorkspace;
    this.autoAcceptLand = options.autoAcceptLand;
    this.mergeTrain = options.mergeTrain;
    this.criticDrive = options.criticDrive;
    this.spendPollMs = options.spendGuardrail?.pollMs ?? 1000;
    this.spendGraceMs = options.spendGuardrail?.graceMs ?? 60_000;
    this.leaseHeartbeatMs = options.leaseHeartbeat?.intervalMs ?? 30_000;
    this.runFacts = new RunFactStore(this.db);
    this.verificationAttempts = new VerificationAttemptStore(this.db);
    this.guardrailEvents = new GuardrailEventStore(this.db);
    this.turnQueue = new TurnQueueStore(this.db);
    this.chainStore = new ExecutionChainStore(this.db);
    this.sessionStore = new SessionStore(this.db);
    // PONC-aware (issue #115): the Runner's settle path is what operator-cancel
    // (`cancelForTask` → `settleTaskRun`) and force-complete travel through, and
    // that path can reach a Run parked in `review`/`landing` while a
    // `LandingCoordinator.land()` is mid-flight. Feeding the same append-only
    // `landing_journal` (keyed on `this.db`, so it reads the very PONC the
    // review-side coordinator wrote) makes this coordinator honour the Point Of
    // No Cancel too: a cancel racing in after the PONC is clamped out and the
    // land stands — without this, that cancel would win here and "un-land" an
    // already-merged Run (the bug reliability-design §0.3 exists to prevent).
    this.settleCoordinator = new RunSettleCoordinator(
      this.runStore,
      this.taskService,
      this.leaseStore,
      this.runFacts,
      (run) => this.events.onRunFinished?.(run),
      new LandingJournalStore(this.db),
      options.sessionRetirement,
    );
    this.tailer = new LiveUsageTailer(
      {
        sample: (runId) => this.sampleSnapshot(runId),
        emit: (runId, snapshot) => this.events.onRunUsage?.({ runId, snapshot }),
        // A live snapshot is decoration; a DB hiccup must never fail a run.
        persist: (runId, snapshot) => {
          try {
            this.runStore.update(runId, { liveUsage: JSON.stringify(snapshot) });
          } catch {
            /* best-effort; the next tick or the finish flush retries */
          }
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
   * each running Run's ids plus its freshest live-usage snapshot, sampled
   * from the same source the ~1s tailer uses — so the endpoint reads the
   * current Usage/Process Tree even between the tailer's ~10s persist ticks.
   */
  activeSnapshots(): { runId: number; taskId: number; snapshot: RunUsageSnapshot | null }[] {
    return [...this.active.values()].map((a) => ({
      runId: a.runId,
      taskId: a.taskId,
      snapshot: this.sampleSnapshot(a.runId),
    }));
  }

  /** Start a run for a ready task. Returns the created run immediately. */
  start(taskId: number): RunRow {
    const task = this.taskService.get(taskId);
    if (task.state !== 'ready') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; only ready tasks can run`);
    }
    const run = this.beginRun(task);
    this.taskService.setState(taskId, 'running');
    return run;
  }

  /**
   * Spawn a run for a task the caller already flipped to running — the afk
   * mirrored pick, whose sequence is flip (the lock) → recheck → claim →
   * spawn, so the flip lands before the tracker write, not with it (issue #32).
   */
  launchClaimed(taskId: number): RunRow {
    const task = this.taskService.get(taskId);
    if (task.state !== 'running') {
      throw new DomainError('invalid_state', `task ${taskId} is ${task.state}; launchClaimed expects a task already flipped to running`);
    }
    return this.beginRun(task);
  }

  /** Validate the harness, snapshot Guardrails, create the run row, and drive it. Shared by start / launchClaimed. */
  private beginRun(task: TaskRow): RunRow {
    const config = this.getConfig();
    const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
    if (!harness) throw new DomainError('validation', `harness '${task.harness}' is not configured`);
    const ws = this.getWorkspace?.(task.workspaceId) ?? { guardrailBudget: null, guardrailProgress: null };
    const snapshot: RunGuardrailSnapshot = {
      guardrailConfig: resolveGuardrails(ws, config),
      priceTable: resolvePrices(config.prices),
    };
    // Claim the Work Context lease transactionally with the Run row: the
    // unique-key CAS (#118) rejects a second afk Run into an already-owned
    // context, and a rejected claim rolls back the run row so no orphan is
    // left. Enforced HERE, the shared funnel, so REST / MCP / Auto-Runner /
    // a second process are all blocked identically — not only pickNext.
    const run = this.db.transaction(() => {
      // The Execution Chain this Run charges its cumulative budget against
      // (issue #129): inherited from the line of work this Run continues (a
      // same-Task new attempt, or a reattempt's linked Task), or a fresh chain
      // when it starts a new line. Resolved inside the transaction so the chain
      // identity and the Run row commit together.
      const chainId = this.chainStore.resolveForTask(task);
      const created = this.runStore.create(task.id, snapshot, chainId);
      // A same-line-of-work predecessor's retained lease is handed off
      // transactionally rather than conflicting (issue #124): if `created`
      // continues the Execution Chain of whoever currently holds this Work
      // Context key, acquireOrTransfer re-points the lease instead of
      // throwing; an unrelated holder still hits the unique-key CAS.
      this.leaseStore.acquireOrTransfer(
        this.workContextKeyFor(task, created),
        created.id,
        'running',
        (existingOwnerRunId) => this.sharesLineOfWork(existingOwnerRunId, created),
      );
      return created;
    });
    // Retry & reject continuation (issue #147): if this Run continues a prior
    // rejected, Session-bound Run, bind it to that same Session so dispatch
    // reloads the conversation (`session/load`) instead of a cold `session/new`.
    // Done outside the claim transaction (like `drive`), so a continuation that
    // can't bind still dispatches fresh — never blocked.
    const bound = this.bindContinuationIfEligible(task, run);
    void this.drive(task, bound, harness).catch(() => {});
    return bound;
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
  private sharesLineOfWork(existingOwnerRunId: number, successor: RunRow): boolean {
    if (successor.chainId == null) return false;
    const owner = this.runStore.get(existingOwnerRunId);
    return owner?.chainId != null && owner.chainId === successor.chainId;
  }

  /**
   * Resolve the Session a retry/reject continuation should reload (issue #147).
   * The follow-up Run continues the line of work of a prior Run a human
   * rejected: for a requeue it is the same Task; for a reattempt (a new Task
   * linked via `reattemptOf`) it is the ORIGINAL Task. Returns the most-recent
   * such prior Run, its durable Session, and the continuation trigger — or null
   * when there is nothing to continue (a fresh Task, no Session-bound rejected
   * prior, or a retired-and-swept Session). Only `human-reject` has a live
   * producer today: the verify/self-heal path re-drives the *same* Run and
   * automatic-retry has no trigger, so both stay latent in the seam.
   */
  private resolveContinuationSource(
    task: TaskRow,
  ): { prior: RunRow; session: SessionRow; trigger: ContinuationTrigger } | null {
    const sourceTaskId = task.reattemptOf ?? task.id;
    const priors = this.runStore.listForTask(sourceTaskId); // ordered by attempt asc
    for (let i = priors.length - 1; i >= 0; i--) {
      const prior = priors[i]!;
      if (prior.sessionRowId === null) continue;
      if (prior.review !== 'rejected' || prior.reviewedAt === null) continue;
      try {
        const session = this.sessionStore.get(prior.sessionRowId);
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
  private bindContinuationIfEligible(task: TaskRow, run: RunRow): RunRow {
    try {
      const src = this.resolveContinuationSource(task);
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
        appendFact('condensed', false);
        return run;
      }

      const bound = this.runStore.update(run.id, {
        sessionRowId: src.session.id,
        sessionId: src.session.harnessSessionId,
      });
      try {
        this.sessionStore.reactivate(src.session.id, Date.now());
      } catch {
        /* best-effort; reactivate is a no-op unless the Session is idle */
      }
      appendFact(plan.mode === 'offer-choice' ? 'full' : 'silent', true);
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
  cancelForTask(taskId: number): void {
    this.settleTaskRun(taskId, 'operator-cancel', { runState: 'cancelled', taskAction: 'none', reason: null });
  }

  /**
   * Stop a task's active run because an operator force-completed it (the task is
   * already `completed` by the time we get here). Mirrors {@link cancelForTask}
   * but settles the Run `completed`: SIGKILL even mid-turn, and drive()'s catch
   * no-ops (finish is idempotent, and its settle only fires while the task is
   * still `running`). Unlike {@link reopenClosedMirrored} this does not wait
   * for the agent to park — the operator asked for it to stop now. The Task is
   * already `completed`, so the projection leaves it untouched (taskAction none);
   * the post-SIGKILL harness-exit fact loses to this agent-finish.
   */
  completeForTask(taskId: number): void {
    this.settleTaskRun(taskId, 'agent-finish/unresolved', { runState: 'completed', taskAction: 'none', reason: null });
  }

  /**
   * Settle a task's Run through the coordinator with `type`/`projection`, whether
   * it is the live harness in `active` (SIGKILLed here) or a Run parked in
   * `phase:'review'` with no live process (issue #114). Shared by operator cancel
   * and force-complete, which differ only in the disposition they record. A
   * review-parked Run is still `running` and holds no live harness, so settling
   * it releases its lease and prevents an operator action on an awaiting-review
   * Task from wedging the Work Context.
   */
  private settleTaskRun(taskId: number, type: RunFactType, projection: SettleProjection): void {
    let handled = false;
    for (const active of this.active.values()) {
      if (active.taskId !== taskId) continue;
      handled = true;
      this.coordinateSettle(this.taskService.get(taskId), this.runStore.get(active.runId), type, projection);
      this.kill(active);
    }
    if (handled) return;
    const parked = this.runStore.listForTask(taskId).find((r) => r.state === 'running');
    if (parked) this.coordinateSettle(this.taskService.get(taskId), parked, type, projection);
  }

  /**
   * Premature-closure backstop (issue #139). A mirrored Task's tracker ticket
   * has closed while the Task is still `running` — but under the
   * close-after-verify model Harmonic itself is the only thing that closes a
   * ticket, and only after verify + land, by which point the Task is already
   * terminal (never `running`). So a close observed here is **premature** — the
   * agent-via-skill or an operator closed it — and a closed ticket must never
   * stand in for verified, landed work. Revert it: reopen the ticket and
   * Escalate the Task to a human. (This supersedes the pre-#139 ADR-0011
   * behaviour, where a closed ticket *was* the completion signal and this
   * settled the Task `completed`.)
   *
   * When an agent *is* attached, no-op unless its turn has ended (`idle`): a
   * mid-turn agent is left to finish, never SIGKILLed mid-tool-call. Crucially
   * the `!idle` guard also covers a Run that is **mid-landing** (post-loop,
   * `idle` cleared) — so Harmonic's own auto-merge close is never mistaken for a
   * premature one and reverted out from under a landing in flight. Otherwise:
   * stop the parked agent, reopen the ticket, and settle the Run Escalated.
   * Runs atomically against {@link drive}'s await points up to the reopen; the
   * `externallySettled` latch it sets makes `drive` skip its own settle.
   *
   * When *no* agent is attached — the Task is `running` on the board but no Run
   * is driving it — reopen the ticket and Escalate the Task directly. Guarded on
   * there being no live Run row (a Run mid-spawn is imminent; leave it). Returns
   * whether it acted.
   */
  async reopenClosedMirrored(taskId: number): Promise<boolean> {
    for (const active of this.active.values()) {
      if (active.taskId !== taskId) continue;
      if (active.externallySettled || !active.idle) return false; // mid-turn / mid-landing / already settling
      active.externallySettled = true;
      // Flush the final usage snapshot before the log's cwd (worktree) is torn down.
      this.tailer.stop(active.runId);
      const run = this.runStore.get(active.runId);
      const task = this.taskService.get(taskId);
      // Revert the premature close, then hand the Task to a human (#139).
      await this.autoDrive?.reopenTicket(task);
      this.settleEscalated(task, run, 'ticket closed before verification and landing (reopened)', {});
      this.kill(active); // stop the parked agent; drive() finalizes the worktree + keys
      return true;
    }
    // No agent is working this Task. Only act on a still-running Task with no
    // live Run in flight, so we never race a Run that is mid-spawn (its
    // ActiveRun not yet registered).
    if (this.taskService.get(taskId).state !== 'running') return false;
    if (this.runStore.listForTask(taskId).some((r) => r.state === 'running')) return false;
    // Reopen the premature close, then Escalate the orphaned Task directly (#139).
    await this.autoDrive?.reopenTicket(this.taskService.get(taskId));
    this.taskService.escalate(taskId);
    return true;
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
   * The agent-driven escalate signal (`escalate_task` MCP tool): the agent is
   * blocked on something only a human can resolve. Records the reason so the
   * run settles Escalated instead of continuing. Returns whether a Run matched.
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
   * so the operator's redirect lands immediately. Otherwise (a parked/idle
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
          const event = this.runStore.appendEvent(active.runId, { type: 'lifecycle', payload: { event: 'steer_injected', text } });
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
    const event = this.runStore.appendEvent(active.runId, { type: 'lifecycle', payload: { event: 'steer_queued', text } });
    this.events.onRunEvent?.(event);
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
      this.tailer.stop(active.runId);
      active.verifyAbort.abort();
      this.kill(active);
    }
    this.active.clear();
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
   * The branch a worktree Run is cut from and lands back onto (issue #157,
   * ADR-0024): the Task's explicit `baseBranch`, or the working dir's current
   * branch when unset — today's behaviour. Cutting from the resolved base
   * (rather than the base repo's current HEAD) is what lets a Run fork off an
   * arbitrary base — later, an Epic's shared integration branch — without the
   * shared working dir having it checked out.
   */
  private async resolveBaseBranch(task: TaskRow): Promise<string> {
    return task.baseBranch ?? (await Git.currentBranch(task.workingDir));
  }

  /**
   * Direct mode runs in place, unlocked. Worktree mode gets a temporary
   * git worktree on branch `harmonic/task-<id>-run-<n>` cut from the
   * {@link resolveBaseBranch resolved base branch}.
   */
  private async prepareWorkspace(task: TaskRow, run: RunRow, resume = false): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') {
      const workspace: Workspace = { cwd: task.workingDir, env: {} };

      // Harmonic owns branching (issue #149, reliability-design Unit D, ADR-0023).
      // For an afk **direct** Run, admission records the exact start-state as a
      // `run-start-state` fact and rejects a context Harmonic cannot safely
      // track — dirty, submodules/nested repos, or a detached HEAD. A native
      // (operator-driven) Run keeps the pre-existing best-effort capture below;
      // a self-heal turn (`resume`) re-enters an already-admitted context that
      // is dirty with the Run's own prior work, so it is never re-gated.
      const afk = this.autoDrive?.handles(task) ?? false;
      if (afk && !resume) {
        let probe: StartStateProbe | null;
        try {
          probe = await this.probeStartState(task.workingDir);
        } catch {
          // Not a git repo (or no commits): the branch contract does not apply,
          // so there is no start-state to record and nothing to reject.
          probe = null;
        }
        if (probe) {
          // No operator landing-branch surface exists yet, so a detached HEAD is
          // always rejected here; `evaluateAdmission`'s landing-branch arm is the
          // forward seam a later operator-input unit wires (reliability-design
          // Unit D — "detached HEAD is rejected or requires an operator-selected
          // landing branch").
          const gate = evaluateAdmission(probe);
          if (!gate.ok) {
            // Routed to `settleEscalated` (operator-legible) by driveOnce's
            // catch, not a generic execution `failed`.
            throw new AdmissionRejected(gate.reason);
          }
          // Snapshot the contract-relevant refs now (issue #151) — the "before"
          // side of the `validating` branch-contract diff. Best-effort: a repo
          // with no refs yet yields `{}`, and a read failure just omits the
          // snapshot, leaving the later check to skip rather than false-fire.
          const refsAtStart = await Git.forEachRef(task.workingDir)
            .then(parseRefLines)
            .catch(() => undefined);
          this.runFacts.append(
            run.id,
            'run-start-state',
            // Spread into a fresh object literal to satisfy the store's
            // `Record<string, unknown>` payload — the same idiom as run-settle.ts.
            { ...gate.startState, ...(refsAtStart ? { refsAtStart } : {}) },
          );
          workspace.baseRev = probe.headOid;
          workspace.startDirty = false; // admission guarantees a clean context

          // Direct-mode execution isolation (issue #152, reliability-design
          // Unit D): detach HEAD at the recorded start commit before the agent
          // is spawned, so its commits/reset land on a private line and can
          // never advance the live target branch. `finalizeWorkspace` restores
          // the live checkout coherently at settle. A native (operator-driven)
          // direct Run keeps its live branch attached — only afk Runs, where no
          // human is watching the checkout, are isolated this way.
          await detachForDirectRun(task.workingDir, gate.startState.startCommit);
          workspace.directIsolation = {
            startBranch: gate.startState.startBranch,
            startCommit: gate.startState.startCommit,
          };
        }
        return workspace;
      }

      // Self-heal continuation (issue #137) of an afk-direct Run: turn 1's
      // `finalizeWorkspace` restored the live checkout, sweeping the leased
      // work off the tree (it lives in the frozen candidate). Rematerialise that
      // candidate and re-detach, so the continuation resumes its prior work AND
      // stays isolated — symmetric to worktree mode re-checking out the run
      // branch (below). The candidate is re-parented on the SAME validated base
      // the first turn recorded, so the re-verify judges the full diff. Missing
      // start-state or candidate (the snapshot was skipped/failed) leaves the
      // turn to the best-effort capture below — nothing to rematerialise.
      if (afk && resume) {
        const start = this.startStateOf(run.id);
        const candidateOid = this.runStore.get(run.id).candidateOid;
        if (start && candidateOid) {
          await rematerializeCandidate(task.workingDir, candidateOid);
          workspace.baseRev = start.startCommit;
          workspace.startDirty = false;
          workspace.directIsolation = {
            startBranch: start.startBranch,
            startCommit: start.startCommit,
          };
          return workspace;
        }
      }

      // Capture the validated base + dirty-state now, before the agent edits
      // anything, so the candidate snapshot (issue #134) can parent on the
      // start commit and skip a context that was already dirty. Best-effort:
      // a non-git working dir simply yields no candidate.
      try {
        workspace.baseRev = await Git.revParse(task.workingDir, 'HEAD');
        // On a self-heal turn (issue #137) the direct context is already dirty
        // with THIS Run's own prior work — the Run owns the context for its
        // duration, so treat it as clean rather than skipping the candidate as
        // an operator's stray edits. A fresh Run keeps the real dirty check.
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
      const persisted = this.runStore.get(run.id);
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
    const branch = `harmonic/task-${task.id}-run-${run.attempt}`;
    await Git.addWorktree(task.workingDir, path, branch, baseBranch);
    this.runStore.update(run.id, { branch, baseBranch });
    // A fresh worktree is clean by construction; the base branch is the
    // validated base the candidate is parented on.
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
  }

  /**
   * Gather the git facts the admission gate (issue #149) needs, before the
   * agent touches anything — the Runner's git-I/O half of the otherwise-pure
   * {@link evaluateAdmission}. `branch` comes from `symbolic-ref` (null on a
   * detached HEAD, never the literal `HEAD`). Throws (via `Git.toplevel` /
   * `revParse`) when `dir` is not a git repo, so the caller treats a non-git
   * context as having no start-state to record or reject.
   */
  /**
   * Read back the `run-start-state` fact (issue #149) a Run recorded at
   * admission — the start branch + commit a later turn detaches from and
   * restores to (issue #152). Returns null when no fact was recorded (a native
   * Run, or a non-git context), so the caller falls back to best-effort capture.
   */
  private startStateOf(runId: number): RunStartState | null {
    const fact = this.runFacts.list(runId).find((f) => f.type === 'run-start-state');
    return fact ? (JSON.parse(fact.payload) as RunStartState) : null;
  }

  private async probeStartState(dir: string): Promise<StartStateProbe> {
    const [root, remote] = await Promise.all([Git.toplevel(dir), Git.originUrl(dir)]);
    const [headOid, branch, dirty, dirtyFingerprint, submodules, nestedRepos] = await Promise.all([
      Git.revParse(dir, 'HEAD'),
      Git.symbolicBranch(dir),
      Git.isDirty(dir),
      Git.statusFingerprint(dir),
      Git.hasSubmodules(dir),
      Git.hasNestedRepos(dir),
    ]);
    return {
      repoIdentity: { root, remote },
      headOid,
      branch,
      dirty,
      dirtyFingerprint,
      submodules,
      nestedRepos,
      worktreePath: dir,
    };
  }

  /**
   * Freeze the agent's work into a verification candidate (issue #134): a
   * `commit-tree` snapshot pinned to a private Harmonic ref that never moves
   * the target branch, proven safe by checking it out in a disposable detached
   * worktree with before/after fingerprints. Runs in `validating`, while the
   * leased workspace still exists (before `finalizeWorkspace` tears a worktree
   * down). No verifier consumes the candidate yet — this is the frozen tree +
   * the safety proof only. A snapshot failure is recorded, not fatal: the phase
   * machine still advances (nothing downstream depends on the candidate yet).
   */
  private async runCandidateSnapshot(
    task: TaskRow,
    run: RunRow,
    workspace: Workspace,
    record: (type: 'lifecycle', payload: unknown) => void,
    // A self-heal turn (issue #137) re-snapshots against the Run's existing
    // candidate ref, so it must overwrite rather than create-only-pin.
    force = false,
  ): Promise<void> {
    if (!workspace.baseRev) return; // no git base captured → nothing to snapshot
    const repoDir = workspace.worktree?.repoDir ?? task.workingDir;
    // Keyed on the globally-unique run id. The ref persists after the Run: the
    // candidate is rematerialized from it for verification, a corrective turn,
    // or a review-reject continuation. Its cleanup is owned by the later
    // verify/landing + Session-retirement units (reliability-design Unit B/C),
    // not this substrate ticket — nothing here deletes it.
    const ref = `refs/harmonic/candidate/run-${run.id}`;
    try {
      // Inside the try so an mkdir failure (ENOSPC/EACCES) is recorded like any
      // other snapshot failure, honouring the non-fatal contract above rather
      // than propagating out and failing the whole Run.
      mkdirSync(this.worktreesDir, { recursive: true });
      const result = await snapshotCandidate({
        repoDir,
        workspaceDir: workspace.cwd,
        baseRev: workspace.baseRev,
        ref,
        message: `harmonic: candidate task ${task.id} run ${run.attempt}`,
        isolationMode: task.isolationMode,
        startDirty: workspace.startDirty ?? false,
        worktreePath: join(this.worktreesDir, `verify-${run.id}`),
        force,
      });
      if (result.status === 'skipped') {
        record('lifecycle', { event: 'candidate', status: 'skipped', reason: result.reason });
        return;
      }
      this.runStore.update(run.id, { candidateOid: result.oid, candidateRef: result.ref });
      record('lifecycle', { event: 'candidate', status: 'created', oid: result.oid, mutated: result.mutated });
    } catch (err) {
      record('lifecycle', {
        event: 'candidate',
        status: 'error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The shared "verifier configured but no frozen candidate to review" outcome
   * (issue #135/#136): the snapshot was skipped or failed (#134), so there is
   * nothing to characterize — infra doubt. Persist an `inconclusive` attempt and
   * feed its verdict to `combineVerdicts` so the gate Escalates rather than
   * silently passing work it never verified. Shared by every verifier branch in
   * {@link runVerification} so a new verifier can't diverge on this fail-safe.
   */
  private noCandidateVerdict(
    runId: number,
    mechanism: 'command' | 'critic',
    record: (type: 'lifecycle', payload: unknown) => void,
  ): VerifierVerdict {
    this.verificationAttempts.append(runId, {
      mechanism,
      inputOid: '',
      verdict: 'inconclusive',
      summary: 'no candidate snapshot to verify',
      output: '',
      mutated: false,
    });
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
   * the Run so broken work never lands. Also returns whether a verifier actually
   * `ran` (produced a verdict) and the resolved `autoAccept` from the same
   * `resolveVerifiers` call (issue #138): `drive` needs both, separately from the
   * decision, to distinguish "proceed because a verifier passed" (auto-accept
   * eligible) from "proceed, nothing configured to verify" (`combineVerdicts([])`
   * is also `proceed`, but there's nothing to auto-accept). With no verifier
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
    harness: HarnessConfig,
    signal: AbortSignal,
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<{ decision: VerificationDecision; ran: boolean; autoAccept: boolean }> {
    const ws = this.getWorkspace?.(task.workspaceId);
    const { command, critic, autoAccept } = resolveVerifiers(
      ws ?? { verificationCommand: null, verificationCritic: null, verificationAutoAccept: null },
      this.getConfig(),
    );

    const verdicts: VerifierVerdict[] = [];
    // The frozen candidate both verifiers review — read once (it cannot change
    // within a single verifying pass). Null means the snapshot was skipped
    // (dirty direct context) or failed (#134): a configured verifier then has
    // nothing to characterize, which every branch below treats as infra doubt
    // → inconclusive → Escalate, never a silent pass.
    const oid = this.runStore.get(run.id).candidateOid;

    if (command) {
      if (!oid) {
        verdicts.push(this.noCandidateVerdict(run.id, 'command', record));
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
        });
        this.verificationAttempts.append(run.id, commandAttemptToInput(attempt));
        record('lifecycle', {
          event: 'verification',
          mechanism: 'command',
          verdict: attempt.verdict,
          summary: attempt.summary,
        });
        verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
      }
    }

    if (critic) {
      // The agent critic (issue #136/#164, ADR-0021, reliability-design Unit B):
      // a second verdict folded into the same `combineVerdicts`. It reviews the
      // frozen candidate's diff against its base (the candidate commit's parent,
      // `${oid}^` — exactly what `snapshotCandidate` committed it against) from a
      // disposable read-only worktree, and never runs against the live checkout.
      if (!oid) {
        verdicts.push(this.noCandidateVerdict(run.id, 'critic', record));
      } else {
        mkdirSync(this.worktreesDir, { recursive: true });
        const attempt = await runCritic({
          repoDir: task.workingDir,
          candidateOid: oid,
          baseRev: `${oid}^`,
          worktreePath: join(this.worktreesDir, `critic-${run.id}`),
          critic,
          // The critic reuses the builder's harness binary (its own model/prompt
          // come from `critic`); `runCritic` strips the tracker credentials and
          // registers no MCP servers, so the turn is contained (issue #136).
          harness,
          harnessId: task.harness,
          // Only pass the seam when injected — `exactOptionalPropertyTypes`
          // forbids an explicit `undefined`, and `runCritic` defaults it to the
          // real `createAcpCriticDrive`.
          ...(this.criticDrive ? { drive: this.criticDrive } : {}),
        });
        this.verificationAttempts.append(run.id, criticAttemptToInput(attempt));
        record('lifecycle', {
          event: 'verification',
          mechanism: 'critic',
          verdict: attempt.verdict,
          summary: attempt.summary,
        });
        verdicts.push({ verifier: attempt.verifier, verdict: attempt.verdict });
      }
    }

    return { decision: combineVerdicts(verdicts), ran: verdicts.length > 0, autoAccept };
  }

  /**
   * Tear the leased workspace down before the task settles, per isolation mode:
   * a **direct** Run whose HEAD was detached (issue #152) has its live checkout
   * restored coherently; a **worktree** Run has its work snapshotted onto its
   * branch and — since issue #148 — the worktree **retained** (bound to the Run's
   * Session), not dropped, so the checkout survives the human-rejection window
   * and Session retirement is the sole owner of its removal. Runs before the task
   * settles so an awaiting-review task always has a reviewable artifact and the
   * operator's checkout is coherent again.
   */
  private async finalizeWorkspace(task: TaskRow, run: RunRow, workspace: Workspace): Promise<void> {
    if (workspace.retainForBranchViolation) {
      // Branch-contract violation (issue #151): the git state IS the evidence.
      // Retain the worktree/refs exactly as the agent left them — do not restore
      // the direct-mode checkout or tear the worktree down — until an operator
      // dispositions the escalation (reliability-design Unit D). The harness is
      // still killed and the tailer stopped by the `finalize()` closure; only the
      // git teardown is skipped here.
      return;
    }
    if (workspace.directIsolation) {
      // Direct-mode execution isolation (issue #152): the Run executed on a
      // detached HEAD so its commits never moved the live target branch. Undo
      // the isolation symmetrically to the worktree teardown below — pin the
      // agent's commit chain to the private ref, then restore the live checkout
      // coherently. Runs before the lease is released at settle, so nothing
      // else can grab the context mid-restore.
      await this.restoreDirectCheckout(task, run, workspace.directIsolation);
      return;
    }
    if (!workspace.worktree) return;
    const { repoDir, path } = workspace.worktree;
    // Commit the agent's work onto the run branch (the durable artifact landing
    // merges) — best-effort, so a commit hiccup never blocks teardown.
    await Git.commitAll(path, `harmonic: task ${task.id} run ${run.attempt}`).catch(() => {});
    // Issue #148 (reliability-design Unit C): **retain** the builder worktree so
    // its removal is owned solely by Session retirement — the checkout then
    // survives the human-rejection window and a reject-and-continue lands in the
    // same workspace. Retention requires a Session to own the removal, so bind
    // the worktree to the Run's Session and retain **only if that bind succeeds**.
    // If there is no Session (the best-effort dispatch write never landed) or the
    // bind fails, retirement could never reclaim this worktree — so dispose of it
    // now rather than leak it. This is the only builder-worktree removal outside
    // retirement, and it fires solely for a worktree retirement structurally
    // cannot own; the invariant "retained ⇔ bound ⇔ retirement owns removal" holds.
    const sessionRowId = this.runStore.get(run.id).sessionRowId;
    let retained = false;
    if (sessionRowId != null) {
      try {
        this.sessionStore.bindWorktree(sessionRowId, repoDir, path, Date.now());
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
   * Undo direct-mode execution isolation (issue #152): capture the agent's
   * commit chain onto the private `refs/harmonic/direct/run-<id>` ref, then
   * re-attach HEAD to the start branch and sweep the agent's changes so the
   * operator's checkout is coherent again. The work is not lost — the full tree
   * is frozen in the candidate (#134) and the commit chain on the private ref.
   * Best-effort: a failed restore leaves the checkout detached for the startup
   * sweep + owned-ref tracking to reconcile, and never breaks the settle funnel.
   */
  private async restoreDirectCheckout(
    task: TaskRow,
    run: RunRow,
    isolation: { startBranch: string; startCommit: string },
  ): Promise<void> {
    try {
      await captureDirectHead(task.workingDir, run.id);
      await restoreLiveCheckout(task.workingDir, isolation.startBranch);
    } catch {
      // Non-fatal: recorded start-state + owned-ref tracking are the backstop.
    }
  }

  /**
   * Classify an afk **direct** Run's git outcome against the branch contract in
   * `validating` (issue #151, reliability-design Unit D). Gathers the observation
   * the pure {@link classifyBranchOutcome} (issue #150) needs — the recorded
   * start-state (issue #149) for the "before" side, live git reads for the
   * "after" side — and returns it alongside the classification, or `null` when
   * the check does not apply (worktree mode, a native direct Run, or a pre-#151
   * Run with no recorded ref snapshot). The caller reads the observation for the
   * structured branch-violation report, so it is never looked up twice.
   *
   * Pins the private direct ref (issue #152; idempotent — `finalizeWorkspace`
   * pins it again on the clean path) so a normal detached HEAD sits on a ref
   * Harmonic can name (the classifier's R3/R5) rather than reading as an unknown
   * commit. It never restores or tears down the checkout — that stays
   * `finalizeWorkspace`'s job, so a violation's evidence survives. Best-effort:
   * any git read failure returns `null` (skip) rather than fabricating a
   * violation; `Git.isAncestor` already resolves a missing ref to `false` (a real
   * divergence signal) without throwing.
   */
  private async classifyBranchContract(
    task: TaskRow,
    run: RunRow,
    workspace: Workspace,
  ): Promise<{ observation: BranchContractObservation; verdict: BranchClassification } | null> {
    const start = this.startStateOf(run.id);
    if (!workspace.directIsolation || !start || !start.refsAtStart) return null;
    const dir = task.workingDir;
    try {
      // Pin the agent's commit chain onto the private owned ref now, so a normal
      // detached HEAD is explained by an owned ref tip; idempotent.
      await captureDirectHead(dir, run.id);
      const [refLines, headCommit, headBranch] = await Promise.all([
        Git.forEachRef(dir),
        Git.revParse(dir, 'HEAD'),
        Git.symbolicBranch(dir),
      ]);
      const intendedBranch = start.startBranch;
      const [intendedContainsStart, intendedContainsHead] = await Promise.all([
        Git.isAncestor(dir, intendedBranch, start.startCommit),
        Git.isAncestor(dir, intendedBranch, headCommit),
      ]);
      const observation: BranchContractObservation = {
        runId: run.id,
        intendedBranch,
        startCommit: start.startCommit,
        expectedWorktreePath: start.worktreePath,
        headBranch,
        headCommit,
        worktreePath: dir,
        refDeltas: diffRefs(start.refsAtStart, parseRefLines(refLines)),
        reachability: { intendedContainsStart, intendedContainsHead },
      };
      return { observation, verdict: classifyBranchOutcome(observation) };
    } catch {
      // A git read failed — treat as not-applicable rather than manufacturing a
      // violation; the boot sweep + owned-ref tracking are the backstop.
      return null;
    }
  }

  /**
   * Deterministically recover and land a **recoverable** afk-direct Run's work
   * with **no agent turn** (issue #154, reliability-design Unit D — recovery is
   * *preferred* over any agent re-merge). A direct Run executed detached (#152),
   * so its verified work lives only on the frozen candidate and the live
   * intended branch never advanced; this reconstructs-and-lands that candidate.
   *
   * Returns:
   *  - `'skip'` — recovery does not apply (no classification, a `clean`/`ambiguous`
   *    outcome, a non-`auto-merge` Merge Fate, no candidate/start-state, or the
   *    pure {@link planDeterministicRecovery} invariant did not hold). The Run
   *    stays on its existing path (worktree merge in `onCompleted`, or the #151
   *    escalate for ambiguous), unchanged.
   *  - `'landed'` — the reconstructed candidate was landed onto the intended
   *    branch; a `branch-recovery` fact records the deterministic land.
   *  - `'escalate'` — the intended branch moved off the recorded start under us,
   *    or the land itself failed; refuse to close over unlanded work.
   *
   * Runs *after* `finalize()` has restored the direct checkout to the intended
   * branch (clean, at the recorded start), so `landBranch` (#153) takes the
   * coherent in-place ff under the Run's exclusive lease — ref + working tree
   * advance together. The start OID is re-verified before the mutation.
   */
  private async recoverAndLand(
    task: TaskRow,
    run: RunRow,
    branchClass: { observation: BranchContractObservation; verdict: BranchClassification } | null,
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<'skip' | 'landed' | 'escalate'> {
    if (!branchClass || branchClass.verdict.outcome !== 'recoverable') return 'skip';
    // Only land when the fate is auto-merge — open-PR/artifact leave the branch
    // untouched, so a recovery land would contradict the fate. Same source of
    // truth `onCompleted` applies (issue #154).
    if (this.autoDrive?.mergeFateFor(task) !== 'auto-merge') return 'skip';
    const start = this.startStateOf(run.id);
    const candidateOid = this.runStore.get(run.id).candidateOid;
    if (!start || !candidateOid) return 'skip';
    const dir = task.workingDir;
    try {
      // The candidate must descend from the recorded start — the pure invariant.
      // `isAncestor(dir, candidate, start)` asks "does the candidate contain start?"
      const candidateDescendsFromStart = await Git.isAncestor(dir, candidateOid, start.startCommit);
      const plan = planDeterministicRecovery({
        classification: branchClass.verdict,
        observation: branchClass.observation,
        candidateOid,
        candidateDescendsFromStart,
      });
      if (!plan) return 'skip'; // not deterministically recoverable → leave on the fallback path
      // Re-verify the start OID before mutating (reliability-design Unit D): the
      // intended branch must still be exactly where the Run started. A branch
      // that advanced (a concurrent land) is not safe to ff over → Escalate.
      const currentBase = await Git.revParse(dir, plan.baseBranch);
      if (currentBase !== start.startCommit) {
        record('lifecycle', {
          event: 'recovery-landing-failed',
          reason: `intended branch '${plan.baseBranch}' advanced from the recorded start commit`,
        });
        return 'escalate';
      }
      const outcome = await landBranch({
        repoDir: dir,
        baseBranch: plan.baseBranch,
        branch: plan.landCommit,
        leaseHeld: true,
      });
      if (!outcome.ok) {
        record('lifecycle', { event: 'recovery-landing-failed', reason: outcome.detail });
        return 'escalate';
      }
      this.runFacts.append(run.id, 'branch-recovery', {
        reason: plan.reason,
        baseBranch: plan.baseBranch,
        landCommit: plan.landCommit,
        mode: outcome.mode,
        oid: outcome.oid,
      });
      record('lifecycle', { event: 'recovery-landed', reason: plan.reason, oid: outcome.oid, mode: outcome.mode });
      return 'landed';
    } catch (err) {
      // A git fault mid-recovery: refuse to close over unlanded work → Escalate,
      // which retains the candidate/refs for operator disposition.
      record('lifecycle', {
        event: 'recovery-landing-failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      return 'escalate';
    }
  }

  /**
   * Land the result of a bounded agent re-merge turn (issue #155,
   * reliability-design Unit D — "agent re-merge is a bounded fallback only when
   * deterministic recovery is ambiguous; success is defined as the corrective
   * result matching an allowed commit-set / tree-diff derived from recorded
   * artifacts — anything else Escalates, no second mutating turn").
   *
   * Runs on the CORRECTIVE turn (after its verification passed) in place of
   * {@link recoverAndLand}: the corrective turn inherits whatever ref litter the
   * first (ambiguous) turn left behind, so the branch *classifier* would
   * spuriously re-flag a perfectly good result. Instead the decision is the pure
   * {@link evaluateReMergeResult} allowed-set gate over git-computed facts — the
   * corrective candidate's tree must reproduce the recorded artifact
   * (`remergeCtx.allowedTree`), descend from the recorded start, and the intended
   * branch must still contain that start. The start OID is re-verified before the
   * mutation (identical to {@link recoverAndLand}), and the land is the same
   * journaled, crash-idempotent `landBranch` (#153).
   *
   * Returns `'landed'` or `'escalate'` — never `'skip'`: a corrective turn must
   * resolve to one or the other, with no further mutating turn.
   */
  private async landReMerge(
    task: TaskRow,
    run: RunRow,
    remergeCtx: ReMergeContext,
    record: (type: 'lifecycle', payload: unknown) => void,
  ): Promise<'landed' | 'escalate'> {
    const start = this.startStateOf(run.id);
    const candidateOid = this.runStore.get(run.id).candidateOid;
    const dir = task.workingDir;
    const reject = (reason: string, detail: string): 'escalate' => {
      this.runFacts.append(run.id, 'branch-violation', { via: 're-merge', reason, detail });
      record('lifecycle', { event: 'branch-remerge-rejected', reason, detail });
      return 'escalate';
    };
    if (!start || !candidateOid) {
      return reject('no-candidate', 'the re-merge turn left no start-state or candidate to land');
    }
    // `landReMerge` is only reached for the #155 fallback, whose `remergeCtx`
    // always carries the recorded allowed-set tree; a merge-train member's
    // corrective turn (issue #163, `allowedTree` absent) re-lands through the
    // train's `onHealComplete` and never reaches here. Guard so the type is
    // narrowed and the impossible case fails closed rather than landing blind.
    const recordedCandidateTree = remergeCtx.allowedTree;
    if (recordedCandidateTree === undefined) {
      return reject('no-candidate', 'the re-merge turn recorded no allowed-set tree to land against');
    }
    try {
      const [correctiveTree, candidateDescendsFromStart, intendedContainsStart] = await Promise.all([
        Git.revParse(dir, `${candidateOid}^{tree}`).catch(() => null),
        // `isAncestor(dir, candidate, start)` asks "does the candidate contain start?"
        Git.isAncestor(dir, candidateOid, start.startCommit),
        Git.isAncestor(dir, start.startBranch, start.startCommit),
      ]);
      const judgment = evaluateReMergeResult({
        recordedCandidateTree,
        correctiveCandidateTree: correctiveTree,
        candidateDescendsFromStart,
        intendedContainsStart,
      });
      if (judgment.verdict === 'escalate') {
        return reject(judgment.reason, judgment.detail);
      }
      // Re-verify the start OID before mutating (reliability-design Unit D): the
      // intended branch must still be exactly where the Run started. A branch that
      // advanced (a concurrent land) is not safe to ff over → Escalate.
      const currentBase = await Git.revParse(dir, start.startBranch);
      if (currentBase !== start.startCommit) {
        return reject('branch-diverged', `intended branch '${start.startBranch}' advanced from the recorded start commit`);
      }
      const outcome = await landBranch({
        repoDir: dir,
        baseBranch: start.startBranch,
        branch: candidateOid,
        leaseHeld: true,
      });
      if (!outcome.ok) {
        return reject('land-failed', outcome.detail);
      }
      this.runFacts.append(run.id, 'branch-recovery', {
        via: 're-merge',
        reason: 'agent-remerge',
        baseBranch: start.startBranch,
        landCommit: candidateOid,
        mode: outcome.mode,
        oid: outcome.oid,
      });
      record('lifecycle', { event: 'recovery-landed', reason: 'agent-remerge', oid: outcome.oid, mode: outcome.mode });
      return 'landed';
    } catch (err) {
      return reject('land-failed', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Drive a Run to a terminal disposition, healing bounded actionable
   * verification failures along the way (issue #137, reliability-design Unit B).
   *
   * The first turn runs through {@link driveOnce}. A `block` verdict — an
   * **actionable** fail, and only that — does not settle; it routes a corrective
   * builder turn back through the per-Session turn queue (single-flight), which
   * re-enters `validating`, rebuilds the candidate, and reruns the FULL verifier
   * suite, so a fix for one check can't silently break another. Heals are
   * bounded by `verification.maxSelfHeals`; exhausting the budget Escalates the
   * Run. An **inconclusive** verdict never heals — {@link driveOnce} Escalates it
   * in place with its cause — so a flaky environment is never mistaken for a code
   * defect. Every other ending settles inside the single turn.
   */
  private async drive(task: TaskRow, run: RunRow, harness: HarnessConfig): Promise<void> {
    const maxHeals = this.getConfig().verification.maxSelfHeals;
    // The Session key for this Run's turn queue. There is no first-class Session
    // entity yet (reliability-design §0), so the globally-unique Run id anchors
    // it — stable across heal turns even as each turn's ACP session id changes.
    const sessionKey = `run-${run.id}`;
    // Charge the heal-COUNT budget against the durable turn-queue substrate: seed
    // from the self-heal turns already recorded for this Run, so the bound
    // survives a crash-resume of the drive loop rather than being a purely
    // in-memory count. This heal count stays per-Run: a fresh Run re-earns its
    // full `maxSelfHeals`. The token/cost SPEND those heal turns consume, by
    // contrast, IS charged cumulatively across the whole Execution Chain (issue
    // #129) — self-heal turns run inside this Run, so their usage is already in
    // this Run's live snapshot, which the chain-cumulative spend poll folds onto
    // the chain's prior floor. So spend can't be reset by a retry; the heal count
    // deliberately can.
    let heals = this.turnQueue.listForSession(sessionKey).filter((t) => t.purpose === 'self-heal').length;
    // A bounded agent re-merge (issue #155) is allowed exactly ONCE per Run; seed
    // the count from the durable queue too, so the "at most one corrective
    // re-merge, and no mutating turn after it" bound survives a crash-resume of
    // this loop rather than being a purely in-memory flag.
    let remerges = this.turnQueue.listForSession(sessionKey).filter((t) => t.purpose === 're-merge').length;
    let healCtx: HealContext | undefined;
    let remergeCtx: ReMergeContext | undefined;
    // The turn_queue row id of the corrective turn currently being driven, so it
    // is settled once its turn completes (kept single-flight: at most one).
    let inFlightTurn: number | null = null;
    for (;;) {
      const outcome = await this.driveOnce(task, run, harness, healCtx, remergeCtx);
      if (inFlightTurn !== null) {
        // The corrective turn we dispatched has run its course — settle its queue
        // row regardless of the verdict; a further fail enqueues the next one.
        try {
          this.turnQueue.settle(inFlightTurn, 'done');
        } catch {
          // Best-effort audit: the row is a record, not this loop's dispatch
          // mechanism, so a settle race never blocks the Run from finishing.
        }
        inFlightTurn = null;
      }
      if (outcome.kind === 'terminal') return;
      if (outcome.kind === 'merge-train-heal') {
        // The merge train hit a rebase conflict on this Epic member's land and
        // already dispatched its one bounded corrective turn (issue #163): its
        // `dispatchHeal` → {@link enqueueReMergeForMember} recorded the queue row
        // (stashed in `pendingMemberReMerge`). Run exactly that turn; its land
        // re-enters the train via `onHealComplete`. Do NOT re-enqueue here — the
        // coordinator already did. Charge `remerges` so drive's existing "no
        // second mutating turn" guard also holds if this corrective turn's own
        // verification fails (the coordinator's `healAttempted` bounds the land
        // rebase; this bounds the turn). `allowedTree` is unused: the member's
        // land re-lands through the train, not the #155 allowed-set gate.
        remerges += 1;
        remergeCtx = { reason: 'merge-train rebase conflict', detail: outcome.detail };
        healCtx = undefined;
        inFlightTurn = this.pendingMemberReMerge.get(run.id) ?? null;
        this.pendingMemberReMerge.delete(run.id);
        continue;
      }
      if (outcome.kind === 'remerge-needed') {
        // Bounded agent re-merge fallback (issue #155): dispatch exactly ONE
        // corrective turn to consolidate the ambiguous branch outcome. A Run that
        // has already spent its re-merge — or has no recorded candidate to derive
        // the allowed set from — Escalates as #151 would have, rather than issuing
        // a second mutating turn.
        const escalateBranchViolation = () =>
          this.settleEscalated(
            task,
            this.runStore.get(run.id),
            `branch contract violated (${outcome.reason}): ${outcome.detail}`,
            {},
          );
        // `driveOnce` only signals `remerge-needed` on the first ambiguous outcome,
        // so this `remerges >= 1` guard is the durable backstop across a crash-resume.
        if (remerges >= 1) {
          escalateBranchViolation();
          return;
        }
        // The allowed set is derived from the recorded artifact — the tree of the
        // pre-re-merge frozen candidate, captured NOW before the corrective turn
        // re-snapshots over it.
        const allowedTree = await this.candidateTree(task, run);
        if (allowedTree === null) {
          escalateBranchViolation();
          return;
        }
        remerges += 1;
        remergeCtx = { reason: outcome.reason, detail: outcome.detail, allowedTree };
        healCtx = undefined; // the corrective turn is a re-merge, not a heal
        inFlightTurn = this.enqueueReMerge(run, sessionKey);
        // The next `driveOnce(remergeCtx)` resets the phase pointer to
        // `executing`, resumes the work, prompts the agent to re-home it cleanly,
        // and re-enters `validating` — where the allowed-set gate lands or
        // Escalates it.
        continue;
      }
      // Actionable verification fail (issue #137). Once a re-merge has been spent,
      // NO further mutating turn is issued (issue #155): a verification fail on
      // the corrective re-merge turn Escalates rather than self-healing.
      if (remerges >= 1) {
        this.settleEscalated(
          task,
          this.runStore.get(run.id),
          `verification failed on the corrective re-merge turn: ${outcome.reason}`,
          {},
        );
        return;
      }
      // Heal if budget remains; otherwise the Run Escalates (exhaustion).
      // `maxSelfHeals: 0` disables self-heal — a fail Escalates on the first turn,
      // exactly as it did before this ticket.
      if (heals >= maxHeals) {
        const reason =
          heals === 0
            ? `verification failed: ${outcome.reason}`
            : `verification failed after ${heals} self-heal attempt(s): ${outcome.reason}`;
        this.settleEscalated(task, this.runStore.get(run.id), reason, {});
        return;
      }
      heals += 1;
      healCtx = { reason: outcome.reason, output: outcome.output, attempt: heals };
      remergeCtx = undefined;
      inFlightTurn = this.enqueueSelfHeal(run, sessionKey, heals);
      // The next `driveOnce(healCtx)` resets the phase pointer to `executing` and
      // records the re-entry itself (§0.4), so the phase sequence stays fully
      // reconstructable from the event log.
    }
  }

  /**
   * The tree OID of a Run's current frozen candidate, or `null` when there is no
   * candidate or the object cannot be resolved. Used to capture the allowed set
   * for a bounded agent re-merge (issue #155) — the recorded artifact the
   * corrective turn must reproduce — before the corrective turn re-snapshots a
   * fresh candidate over `runs.candidateOid`. Best-effort: a git fault yields
   * `null`, which the caller treats as "cannot re-merge" and Escalates.
   */
  private async candidateTree(task: TaskRow, run: RunRow): Promise<string | null> {
    const candidateOid = this.runStore.get(run.id).candidateOid;
    if (!candidateOid) return null;
    try {
      return await Git.revParse(task.workingDir, `${candidateOid}^{tree}`);
    } catch {
      return null;
    }
  }

  /**
   * Record a self-heal turn on the per-Session turn queue (issue #137): enqueue
   * → claim → mark in-flight, so the corrective turn about to run is the single
   * in-flight turn for this Session — the `turn_queue_single_flight` index is the
   * integrity backstop. The frozen candidate the heal resumes from binds the
   * mutating turn (it uniquely identifies the work state this turn is bound to),
   * satisfying the store's mutating-turn precondition. Returns the row id to
   * settle once the turn finishes, or `null` if the queue write failed — the
   * heal still runs (this in-process loop is the dispatch; the row is an audit
   * record), so an audit-write hiccup never blocks the fix.
   */
  private enqueueSelfHeal(run: RunRow, sessionKey: string, attempt: number): number | null {
    try {
      const oid = this.runStore.get(run.id).candidateOid ?? '';
      const now = Date.now();
      const row = this.turnQueue.enqueue(
        sessionKey,
        run.id,
        'self-heal',
        {
          expectedPhase: 'validating',
          expectedGeneration: run.attempt,
          expectedWorkspaceOID: oid,
          expectedFingerprint: oid,
        },
        now,
      );
      this.turnQueue.claim(row.id, now);
      this.turnQueue.markInFlight(row.id, `self-heal-run-${run.id}-${attempt}`, now);
      return row.id;
    } catch {
      return null;
    }
  }

  /**
   * Record the single bounded agent re-merge turn on the per-Session turn queue
   * (issue #155): enqueue → claim → mark in-flight, exactly like
   * {@link enqueueSelfHeal} but with `purpose: 're-merge'`. That purpose is
   * `isMutating`, so the store enforces the `expectedWorkspaceOID` /
   * `expectedFingerprint` binding, and — crucially for the crash requirement — a
   * `re-merge` turn left `in_flight` by a crash is reconciled by
   * `CrashRecoveryCoordinator` exactly as a `self-heal` is (escalate, never blind
   * replay), for free via `isMutating`. Returns the row id to settle once the
   * turn finishes, or `null` if the queue write failed (the corrective turn still
   * runs — this in-process loop is the dispatch; the row is an audit record).
   */
  private enqueueReMerge(run: RunRow, sessionKey: string): number | null {
    try {
      const oid = this.runStore.get(run.id).candidateOid ?? '';
      const now = Date.now();
      const row = this.turnQueue.enqueue(
        sessionKey,
        run.id,
        're-merge',
        {
          expectedPhase: 'validating',
          expectedGeneration: run.attempt,
          expectedWorkspaceOID: oid,
          expectedFingerprint: oid,
        },
        now,
      );
      this.turnQueue.claim(row.id, now);
      this.turnQueue.markInFlight(row.id, `re-merge-run-${run.id}`, now);
      return row.id;
    } catch {
      return null;
    }
  }

  /**
   * The merge train's `dispatchHeal` (issue #163), wired in app.ts: a member's
   * rebase conflicted on its land, so record its one bounded corrective turn on
   * the member's Session turn queue — the same `re-merge` row {@link drive}
   * dispatches for the #155 fallback. MUST return on *enqueue*, not on the
   * corrective turn's completion: the coordinator holds the integration branch's
   * lock slot across this call, so awaiting the whole turn would stall other
   * ready members on the same branch. The turn itself is run by the `drive`
   * loop (this in-process loop is the dispatch; the row is the durable record),
   * which reads the stashed row id back from {@link pendingMemberReMerge} to
   * settle it once the corrective turn has run.
   */
  enqueueReMergeForMember(member: MergeTrainMember): void {
    const run = this.runStore.get(member.runId);
    const rowId = this.enqueueReMerge(run, `run-${member.runId}`);
    if (rowId !== null) this.pendingMemberReMerge.set(member.runId, rowId);
  }

  /**
   * The merge train's `escalate` (issue #163), wired in app.ts: a member could
   * not land (branch missing, second rebase conflict, unexpected checkout, or a
   * concurrent advance beat its CAS). Hand the Task back to a human exactly as
   * any other afk escalation does — Run failed, Task ready + escalated. This is
   * the SOLE settle authority on a merge-train escalate: `driveOnce` only records
   * the `escalated` outcome and stops, so the Run is never settled twice.
   */
  settleEscalatedForMember(member: MergeTrainMember, reason: string): void {
    const run = this.runStore.get(member.runId);
    const task = this.taskService.get(member.taskId);
    this.settleEscalated(task, run, reason, {});
  }

  /**
   * The {@link MergeTrainMember} for a finishing Run when it is a parallel-Epic
   * member that should land through the merge train (issue #163), or `null` when
   * it is an ordinary Run that lands the direct way. A member is: a worktree Run
   * (has a branch + retained worktree) whose base is an Epic integration branch
   * (`epic/<ref>`), on a server with the train wired, and whose Merge Fate is
   * `auto-merge` — `open-PR`/`artifact` deliberately never touch the integration
   * branch, so they keep `onCompleted`'s behaviour.
   */
  private epicMemberFor(task: TaskRow, run: RunRow, workspace: Workspace): MergeTrainMember | null {
    if (!this.mergeTrain) return null;
    if (task.isolationMode !== 'worktree') return null;
    if (!run.branch || !run.baseBranch) return null;
    if (parseIntegrationBranch(run.baseBranch) === null) return null;
    if (!workspace.worktree) return null;
    if (this.autoDrive?.mergeFateFor(task) !== 'auto-merge') return null;
    return {
      runId: run.id,
      taskId: task.id,
      repoDir: task.workingDir,
      integrationBranch: run.baseBranch,
      memberBranch: run.branch,
      memberWorktreeDir: workspace.worktree.path,
    };
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
    healCtx?: HealContext,
    remergeCtx?: ReMergeContext,
  ): Promise<TurnOutcome> {
    const record = (type: 'session_update' | 'permission_request' | 'lifecycle', payload: unknown) => {
      const event = this.runStore.appendEvent(run.id, { type, payload });
      // Feed the live-usage tailer's current-activity line (ADR 0010).
      if (type === 'session_update') {
        const line = activityLine(payload);
        if (line) active.activity = line;
      }
      this.events.onRunEvent?.(event);
    };

    // Advance the Run through the phase machine (issue #114) up to and including
    // `to`, following `gate` at the verifying branch. Each intermediate phase is
    // persisted on the Run row (`runs.phase`, the current-phase pointer surfaced
    // on the API + card) and recorded as a lifecycle event, so the *sequence* of
    // phases the Run passed through survives a restart and is reconstructable
    // from the event log — never inferred from Task columns.
    const advancePhase = (to: RunPhase, gate: ReviewGate) => {
      const from = this.runStore.get(run.id).phase ?? 'executing';
      for (const phase of phasePath(from, to, gate)) {
        this.runStore.update(run.id, { phase });
        record('lifecycle', { event: 'phase', phase });
      }
    };

    // Set when an afk mirrored Run blocks on a human prompt: the Run stops and
    // the Task Escalates (issue #33) instead of settling completed/failed.
    let escalating: string | null = null;
    const autoDriven = this.autoDrive?.handles(task) ?? false;

    // A corrective turn — a self-heal (issue #137) or a bounded agent re-merge
    // (issue #155) — re-enters the pipeline at `validating` (§0.4). The phase
    // machine is acyclic — it cannot step back from `verifying` on its own — so
    // reset the pointer to `executing` and record the re-entry as a lifecycle
    // event, exactly as `advancePhase` would, so the phase sequence stays
    // reconstructable from the event log. This re-drives the SAME Run / Work
    // Context lease / branch; the ACP transcript is not reloaded (`session/load`
    // isn't built), so the prior failure/violation is carried forward as the
    // corrective prompt below rather than as conversation history.
    if (healCtx || remergeCtx) {
      this.runStore.update(run.id, { phase: 'executing' });
      record('lifecycle', { event: 'phase', phase: 'executing' });
    }

    let child: ChildProcess;
    let workspace: Workspace;
    let mcpServers: unknown[] = [];
    // Unit C (#141): the harness's `initialize` capabilities, captured mid-
    // handshake, and the durable Session row written once its `sessionId` is
    // known — both filled by the handshake callbacks below and read after it
    // to record the resolved permission mode.
    let sessionInit: AcpInitializeResult | undefined;
    let sessionRowId: number | undefined;
    // Tracked separately from `workspace` so the catch below can restore a
    // direct-mode detach (issue #152) even if the harness never spawns —
    // `finalize()` (which normally restores) is only wired after this try.
    let directIsolation: Workspace['directIsolation'] = undefined;
    // A harness that dies without a clean ACP error (codex-acp exiting
    // non-zero mid-handshake) explains itself only on stderr. Retain its
    // tail so the failure reason carries the cause, not a bare exit code;
    // draining the pipe also prevents backpressure on a chatty process.
    let stderrTail = '';
    let stderrFlushed: Promise<void> = Promise.resolve();
    try {
      workspace = await this.prepareWorkspace(task, run, healCtx !== undefined || remergeCtx !== undefined);
      directIsolation = workspace.directIsolation;
      // Agents reach the MCP server with zero setup: a Run Key (its
      // lifetime follows the run's) plus the endpoint, in the environment
      // — and, where the harness supports it (codex), registered directly
      // via ACP `session/new` mcpServers.
      if (this.keys && this.mcpUrl) {
        const runKey = this.keys.mint(run.id);
        workspace.env.HARMONIC_API_KEY = runKey;
        workspace.env.HARMONIC_MCP_URL = this.mcpUrl;
        mcpServers = adapterFor(task.harness).mcpServers({ url: this.mcpUrl, token: runKey });
      }
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
        this.keys?.revoke(run.id);
      } catch {
        // Best-effort; the startup sweep is the backstop.
      }
      // If prepareWorkspace already detached the live checkout (issue #152) but
      // the harness never started, restore it here — `finalize()` is not reached
      // on this path, so nothing else would re-attach HEAD to the live branch.
      if (directIsolation) {
        await this.restoreDirectCheckout(task, run, directIsolation);
      }
      if (err instanceof AdmissionRejected) {
        // Admission gate (issue #149): a context Harmonic cannot safely own is
        // handed to a human with the operator-legible reason, not settled as a
        // generic execution failure.
        this.settleEscalated(task, run, err.reason, {});
      } else {
        this.settle(task, run, 'failed', err instanceof Error ? err.message : String(err));
      }
      return { kind: 'terminal' };
    }

    let finalized = false;
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      // Stop tailing before the log's cwd (worktree) is torn down; this also
      // flushes the final snapshot to the row (ADR 0010: always on finish).
      this.tailer.stop(run.id);
      this.kill(active);
      try {
        this.keys?.revoke(run.id);
      } catch {
        // Revocation is best-effort; keys also die with the database row.
      }
      await this.finalizeWorkspace(task, run, workspace).catch(() => {});
    };

    const driver = new AcpDriver(child, {
      onSessionUpdate: (update) => {
        record('session_update', update);
        observeTool(update); // feed the tool-timeout watchdog (issue #131)
      },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') {
          // In auto mode the harness only asks on a genuinely risky tool (safe
          // ones are auto-approved and never reach here), so a request from an
          // afk Run means "needs a human decision" → Escalate: decline, stop the
          // turn, and flag it for the settle path to hand the Task back (issue
          // #33). Without auto mode the Run has already failed closed upstream.
          if (autoDriven) {
            escalating = (params as any)?.toolCall?.title ?? 'permission request';
            const outcome = { outcome: 'cancelled' };
            record('permission_request', { request: params, outcome });
            driver.cancel();
            return { outcome };
          }
          const options = (params as any)?.options ?? [];
          const pick =
            options.find((o: any) => o.kind === 'allow_always') ??
            options.find((o: any) => o.kind === 'allow_once') ??
            options[0];
          const outcome = pick
            ? { outcome: 'selected', optionId: pick.optionId }
            : { outcome: 'cancelled' };
          record('permission_request', { request: params, outcome });
          return { outcome };
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
      steerable: true,
      verifyAbort: new AbortController(),
    };
    this.active.set(run.id, active);

    // Wall-clock Guardrail watchdog (issue #127, ADR-0019). Armed once the
    // session is live (below) for the Run's *remaining* execution budget; a
    // one-shot timer because the execution phases (`executing/validating/
    // verifying`) are a contiguous prefix of the Run — it can only fire while
    // this `driveOnce` is running, and the `finally` clears it the instant the
    // Run parks in `review`, lands, or settles. That is exactly the phase
    // scoping: time a Run spends parked awaiting a human (review SLA) or in a
    // non-interruptible land never counts, because the watchdog isn't armed
    // then. On fire it appends a structured `guardrail_events` row and settles
    // the Run through the coordinator by precedence — `guardrail-trip` →
    // Escalation (afk→hitl), never a direct settle, never a new terminal state.
    let guardrailTimer: ReturnType<typeof setTimeout> | null = null;
    const armGuardrail = () => {
      const started = this.runStore.get(run.id);
      const budget = started.guardrailConfig
        ? (JSON.parse(started.guardrailConfig) as ResolvedGuardrails).budget
        : null;
      if (!budget) return; // no snapshot (legacy Run) → no wall-clock guard
      // Resolve the limit's provenance now — at (or within milliseconds of) the
      // Run-start snapshot instant — and capture it, rather than looking it up
      // when the timer fires. The enforced limit is the immutable snapshot's
      // (issue #126); a live workspace lookup at fire time (possibly long after)
      // could attribute the snapshotted limit to a since-changed override.
      const ws = this.getWorkspace?.(task.workspaceId);
      const configSource = ws?.guardrailBudget ? 'workspace' : 'default';
      const remaining = Math.max(0, wallClockBudgetMs(budget) - (Date.now() - started.startedAt));
      guardrailTimer = setTimeout(() => {
        guardrailTimer = null;
        if (active.externallySettled) return; // already ended some other way
        const now = this.runStore.get(run.id);
        if (now.state !== 'running') return; // settled/terminal — nothing to trip
        // Phase-scoped (issue #127, reliability-design Unit A): a trip only
        // counts when observed inside an execution phase. `now - startedAt` is
        // the execution clock precisely because the counted phases are a
        // contiguous prefix — this watchdog is armed only within `driveOnce`,
        // which the Run leaves for `review`/`landing` by *returning*, and the
        // `finally` clears the timer at that point. If the timer nonetheless
        // fires mid-`review`/`landing`, `wallClockTrip` returns null (that phase
        // does not count) and the Run is left alone.
        const trip = wallClockTrip({ elapsedMs: Date.now() - now.startedAt, phase: now.phase ?? null, budget });
        if (!trip) return; // fired in a non-counted phase, or not actually over budget
        // Structured evidence first — the card reason derives from this row.
        this.guardrailEvents.append(now.id, {
          dimension: trip.dimension,
          phase: now.phase ?? 'executing',
          limitValue: trip.limitMs,
          observedValue: trip.observedMs,
          configSource,
        });
        const reason = formatBudgetReason(trip);
        record('lifecycle', { event: 'guardrail-tripped', dimension: trip.dimension, reason });
        // Claim the settle so the drive loop's own settle path (unwinding from
        // the killed harness) no-ops instead of finishing the Run twice.
        active.externallySettled = true;
        this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
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
    const tripSpend = (
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
      this.guardrailEvents.append(now.id, event);
      record('lifecycle', { event: 'guardrail-tripped', dimension: event.dimension, reason });
      active.externallySettled = true;
      this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
      active.verifyAbort.abort();
      this.kill(active);
      if (spendTimer) {
        clearInterval(spendTimer);
        spendTimer = null;
      }
    };
    const armSpendGuardrail = () => {
      const started = this.runStore.get(run.id);
      const budget = started.guardrailConfig
        ? (JSON.parse(started.guardrailConfig) as ResolvedGuardrails).budget
        : null;
      if (!budget) return; // no snapshot (legacy Run) → no spend guard
      if (budget.tokens == null && budget.costUsd == null) return; // no spend caps configured
      const priceTable: PriceTable = started.priceTable ? (JSON.parse(started.priceTable) as PriceTable) : {};
      // Resolved at arm time, not fire time — same provenance rule as `armGuardrail`.
      const ws = this.getWorkspace?.(task.workspaceId);
      const configSource: 'default' | 'workspace' = ws?.guardrailBudget ? 'workspace' : 'default';
      // Prior cumulative spend of this Run's Execution Chain (issue #129): the
      // token/cost already charged by the sibling Runs that continued the same
      // line of work before this one (reattempt / mirrored retry / crash-resume).
      // Summed once at arm time — those Runs are settled, so their frozen usage
      // is immutable for the life of this poll — and each member is priced with
      // ITS OWN frozen price table (issue #126), so a later price edit can't
      // retroactively change what a past Run cost. A member with no recorded
      // usage contributes a 0 floor (see `sumPriorSpend`); self-heal turns need
      // no accounting here because they run inside this same Run.
      const priorSpend = sumPriorSpend(
        (started.chainId == null ? [] : this.chainStore.listForChain(started.chainId))
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
      spendTimer = setInterval(() => {
        if (active.externallySettled) return;
        const now = this.runStore.get(run.id);
        if (now.state !== 'running') return;
        const snap = this.sampleSnapshot(run.id);
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
          tripSpend(
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
        tripSpend(now, event, reason);
      }, this.spendPollMs);
      spendTimer.unref?.();
    };

    // Work Context lease heartbeat (issue #122): coordinator-driven, on a
    // wall-clock timer independent of agent/tool output — a Run stuck in a
    // long tool call still bumps its lease's liveness, so the lease never
    // lapses while the Run is genuinely alive. Phase-specific TTL (`lease-ttl.ts`):
    // the Run's current phase sets the expiry budget, so the review gate rides
    // a far longer window than the execution phases.
    let leaseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const armLeaseHeartbeat = () => {
      const key = this.workContextKeyFor(task, run);
      const beat = () => {
        if (active.externallySettled) return;
        const now = this.runStore.get(run.id);
        if (now.state !== 'running') return;
        this.leaseStore.heartbeat(key, Date.now(), now.phase ?? 'executing');
      };
      beat(); // set expiry immediately, before the first interval tick
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
    const progressStart = this.runStore.get(run.id);
    const progressSnapshot = progressStart.guardrailConfig
      ? (JSON.parse(progressStart.guardrailConfig) as ResolvedGuardrails)
      : null;
    const progressEnabled = progressSnapshot?.progress === true;
    const progressConfigSource: 'default' | 'workspace' = this.getWorkspace?.(task.workspaceId)
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
    const tripProgressGuardrail = (
      now: RunRow,
      evidence: { dimension: 'progress' | 'tool-timeout'; limitValue: number; observedValue: number; payload: unknown },
      reason: string,
    ) => {
      this.guardrailEvents.append(now.id, {
        dimension: evidence.dimension,
        phase: now.phase ?? 'executing',
        limitValue: evidence.limitValue,
        observedValue: evidence.observedValue,
        configSource: progressConfigSource,
        payload: evidence.payload,
      });
      record('lifecycle', { event: 'guardrail-tripped', dimension: evidence.dimension, reason });
      active.externallySettled = true;
      this.coordinateSettle(task, now, 'guardrail-trip', { runState: 'failed', taskAction: 'escalate', reason }, {});
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
      toolTimeoutTimer = setInterval(() => {
        if (active.externallySettled) return;
        const now = this.runStore.get(run.id);
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
        tripProgressGuardrail(
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
    const checkProgressAtBoundary = (): boolean => {
      // Off, already settled, or the agent has signalled finish/escalate — in
      // the last case the Run is completing this turn, so a lingering pre-finish
      // stall tail must not nudge or (worse) trip it: honour the finish.
      if (!progressEnabled || active.externallySettled || active.agentFinished || active.escalateReason) return false;
      const report = detectStall(toProgressEvents(this.runStore.listEvents(run.id)), { enabled: true });
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
      const now = this.runStore.get(run.id);
      if (now.state !== 'running') return false;
      tripProgressGuardrail(
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
      const persistSession = (harnessSessionId: string) => {
        this.runStore.update(run.id, { sessionId: harnessSessionId });
        try {
          const session = this.sessionStore.recordDispatch({
            harness: task.harness,
            harnessSessionId,
            model: task.model,
            cwd: workspace.cwd,
            workspaceId: task.workspaceId,
            mcpTemplates: mcpServers,
            capabilities: sessionInit,
            adapterVersion: adapterVersion(task.harness),
            now: Date.now(),
          });
          sessionRowId = session.id;
          this.runStore.update(run.id, { sessionRowId: session.id });
        } catch {
          /* best-effort; the Session is additive, the Run proceeds regardless */
        }
      };
      // Snapshot the harness's `initialize` capabilities (incl. `loadSession`)
      // for the durable Session; shared by both dispatch paths.
      const onInitialize = (result: AcpInitializeResult) => {
        sessionInit = result;
      };
      // Retry & reject continuation (issue #147): a first (non-corrective) turn
      // on a Run pre-bound to a prior Session (`bindContinuationIfEligible`)
      // reloads that conversation via `session/load` instead of a cold
      // `session/new`, so the agent still remembers what it tried and the
      // feedback it got. A corrective turn (self-heal #137 / re-merge #155)
      // re-drives the SAME live process and must NOT reload — it carries its
      // correction as prompt text below — so it always takes the fresh
      // handshake. On any load incompatibility Harmonic fails forward to a fresh
      // Session rather than leaving the Run session-less.
      const continueSessionId = healCtx === undefined && remergeCtx === undefined ? run.sessionId : null;
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
          persistSession(continueSessionId);
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
      armGuardrail();
      // Arm the hard tool-timeout watchdog alongside it (issue #131; a no-op
      // when the progress Guardrail is off). The stall detector is evaluated at
      // turn boundaries in the loop below, not on a timer.
      armToolTimeout();
      // Arm the token/cost spend Guardrail poll (issue #128; a no-op when
      // neither `tokens` nor `costUsd` is configured on the Run's frozen budget).
      armSpendGuardrail();
      // Arm the Work Context lease heartbeat (issue #122).
      armLeaseHeartbeat();

      // An afk Run executes unattended, so put the harness into an auto
      // permission mode: Claude's 'auto' classifier auto-approves safe tools
      // and only asks on genuinely risky ones (those still Escalate, below);
      // 'bypassPermissions' is the fallback for harnesses without 'auto'. Fail
      // closed if neither is offered, rather than prompt on every tool call and
      // Escalate immediately (issue #33 follow-up; pattern from ../starchart).
      if (autoDriven) {
        const mode = AFK_PERMISSION_MODES.find((m) => driver.availableModes.includes(m));
        if (!mode) {
          throw new Error(
            `harness '${task.harness}' offers no unattended permission mode ` +
              `(need one of ${AFK_PERMISSION_MODES.join('/')}; available: ${driver.availableModes.join(', ') || 'none'})`,
          );
        }
        await driver.setMode(mode);
        record('lifecycle', { event: 'mode_set', mode });
        // Unit C (#141): the Session's permission mode is only resolved here,
        // after the handshake — record it onto the durable Session row.
        // Best-effort for the same reason as the Session write above. (Native
        // Runs set no ACP mode, so their Session's permissionMode stays null —
        // an accurate "Harmonic set no mode", not a missing capture.)
        if (sessionRowId !== undefined) {
          try {
            this.sessionStore.setPermissionMode(sessionRowId, mode, Date.now());
          } catch {
            /* best-effort; additive */
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
      let promptText = autoDriven ? this.autoDrive!.prompt(task) : promptForTask(task, this.getConfig().taskPrompt);
      // A self-heal turn (issue #137) re-drives the same builder on its resumed
      // work, so append the verification failure as corrective feedback: fix the
      // cause, then finish, and the full suite reruns against the new candidate.
      if (healCtx) {
        promptText =
          `${promptText}\n\n## Verification failed — fix required (self-heal ${healCtx.attempt})\n` +
          `Your previous attempt did not pass verification:\n${healCtx.reason}\n\n${healCtx.output}\n\n` +
          `Fix the cause so the full verification suite passes, then finish.`;
      } else if (remergeCtx) {
        // Bounded agent re-merge turn (issue #155): the previous turn left the
        // repository in a branch state Harmonic cannot deterministically land.
        // Ask the agent to re-home exactly the same work cleanly — Harmonic lands
        // it — WITHOUT extra branches or new changes (the allowed-set gate rejects
        // a divergent tree). Marked `agent re-merge 1` so the run is one bounded
        // corrective turn.
        const intended = this.startStateOf(run.id)?.startBranch ?? 'the branch the task started on';
        promptText =
          `${promptText}\n\n## Branch consolidation required (agent re-merge 1)\n` +
          `Your previous turn left the repository in a branch state Harmonic cannot land: ${remergeCtx.detail}\n\n` +
          `Re-home the work you already did as ordinary commits on top of \`${intended}\`. ` +
          `Do not create or switch branches, and do not change any files beyond the work you already did — ` +
          `only reproduce that same work cleanly. Then finish.`;
      }
      // Persist the exact text sent so Task detail can show it on every Run —
      // native or mirrored — without re-deriving a template that may since have
      // changed (the "Prompt" tab reads this column). Steer/continue turns are
      // recorded as lifecycle events, not folded into this initial prompt.
      this.runStore.update(run.id, { prompt: promptText });
      let result = await driver.prompt([{ type: 'text', text: promptText }]);
      active.idle = true; // turn ended → parked; the backstop may Escalate a prematurely-closed ticket here
      // Steering + auto-drive continue loop. `attempt` counts only auto-drive
      // continue nudges, so operator steers never eat into the continue budget.
      for (let attempt = 1; !escalating; ) {
        if (active.externallySettled) break; // the poll Escalated a prematurely-closed ticket while parked
        if (active.escalateReason) {
          escalating = active.escalateReason; // agent asked for a human → settle Escalated
          break;
        }
        // Progress Guardrail (issue #131), evaluated here at the turn boundary —
        // the agent is parked, so the check and its one nudge never run
        // concurrently with an in-flight turn. First stall enqueues a single
        // nudge (drained as the next turn just below); a stall that survives that
        // nudge trips → Escalate, and we break to unwind through the
        // `externallySettled` guards.
        if (checkProgressAtBoundary()) break;
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
      while (!active.externallySettled && !escalating && active.steerQueue.length > 0) {
        const steer = active.steerQueue.shift()!;
        record('lifecycle', { event: 'steer_delivered', text: steer });
        result = await driver.prompt([{ type: 'text', text: steer }]);
      }
      if (active.externallySettled) {
        // The poll already finished the Run completed and settled the Task; drop
        // the harness and stop — settling again would finish the Run twice.
        await finalize();
        return { kind: 'terminal' };
      }

      record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
      // An afk Run that ended without the `finish_task` signal — its continue
      // budget spent, or a single turn that never finished — has no
      // execution-complete signal (#139), so there is nothing to verify or land:
      // route it to the failure path (Auto-Retry, then Escalate) without
      // freezing a candidate, verifying, or closing the ticket. A native Run
      // always verifies its single ended turn.
      const afkUnresolved = autoDriven && !escalating && !active.agentFinished;
      // The `validating` branch-contract classification (issue #151), hoisted so
      // the afk landing block below can reach it for deterministic recovery
      // landing (issue #154). Null when the check does not apply (worktree mode,
      // native direct, a pre-#151 Run) or was skipped (escalating/afkUnresolved).
      let branchClass: { observation: BranchContractObservation; verdict: BranchClassification } | null = null;
      // Set when a first-turn ambiguous outcome is eligible for a bounded agent
      // re-merge (issue #155): instead of Escalating in place (#151), hand the
      // decision up to the `drive` loop, which dispatches exactly one corrective
      // turn. Carries the branch-contract violation for the corrective prompt.
      let remergeNeeded: { reason: string; detail: string } | null = null;
      // Enter `validating` and freeze the verification candidate there, while
      // the leased workspace still exists — finalize() tears a worktree down.
      // The phase is persisted *before* the git work so `runs.phase` reads
      // `validating` for its duration; the branch-specific advance below then
      // continues from `validating` to `verifying`/`review`. Skipped for an
      // escalating Run (never reaches `verifying`, #134) and for an
      // afkUnresolved Run (no completion to verify).
      if (!escalating && !afkUnresolved) {
        advancePhase('validating', autoDriven ? 'auto' : 'human');
        await this.runCandidateSnapshot(
          task,
          run,
          workspace,
          record,
          healCtx !== undefined || remergeCtx !== undefined,
        );
        // Branch-contract enforcement (issue #151, reliability-design Unit D):
        // still in `validating`, before any checkout restore / worktree teardown,
        // classify the Run's git outcome against the recorded start-state (#149)
        // with the pure #150 classifier. A clean/recoverable outcome (the expected
        // direct-mode detached-HEAD footprint) proceeds; its deterministic restore
        // is `finalize()`'s job, and a recoverable afk auto-merge Run lands via
        // {@link recoverAndLand} below (issue #154), so the classification is
        // retained for that seam.
        branchClass = await this.classifyBranchContract(task, run, workspace);
        // On a CORRECTIVE re-merge turn (issue #155) the ambiguous verdict is NOT
        // acted on here: the corrective turn inherits the first turn's ref litter,
        // so the classifier would spuriously re-flag it. Its success is judged by
        // the allowed-set gate in {@link landReMerge} after verification instead.
        if (remergeCtx === undefined && branchClass && branchClass.verdict.outcome === 'ambiguous') {
          const { observation } = branchClass;
          const verdict = branchClass.verdict;
          // A bounded agent re-merge (issue #155) is *preferred* over an immediate
          // Escalate when the Run can support one: an afk-direct auto-merge Run
          // with a recorded candidate to derive the allowed set from. Hand the
          // decision up to `drive`, which dispatches exactly one corrective turn.
          // Everything else Escalates in place, exactly as #151 did.
          const remergeEligible =
            autoDriven &&
            !!workspace.directIsolation &&
            this.autoDrive?.mergeFateFor(task) === 'auto-merge' &&
            this.runStore.get(run.id).candidateOid != null;
          if (remergeEligible) {
            remergeNeeded = { reason: verdict.reason, detail: verdict.detail };
          } else {
            // An **ambiguous** outcome Harmonic cannot silently verify or land:
            // emit the structured branch-violation fact, retain the refs as
            // evidence, and Escalate through the shared tail below.
            this.runFacts.append(run.id, 'branch-violation', {
              outcome: verdict.outcome,
              reason: verdict.reason,
              detail: verdict.detail,
              deltas: verdict.deltas,
              intendedBranch: observation.intendedBranch,
              headBranch: observation.headBranch,
              headCommit: observation.headCommit,
            });
            record('lifecycle', { event: 'branch-violation', reason: verdict.reason, detail: verdict.detail });
            // Retain the worktree/refs for operator disposition (finalizeWorkspace
            // skips its teardown while this is set) and route through the shared
            // escalation tail below — finalize → usage → settleEscalated — rather
            // than re-implementing it here.
            workspace.retainForBranchViolation = true;
            escalating = `branch contract violated (${verdict.reason}): ${verdict.detail}`;
          }
        }
      }
      await finalize();
      const usage = await this.collectUsageSafe(task, run, harness, workspace, result);
      this.noteModelMismatch(task, usage, record);
      const patch = { stopReason: result.stopReason ?? null, usage: usage ? JSON.stringify(usage) : null };
      if (escalating) {
        record('lifecycle', { event: 'escalated', reason: escalating });
        this.settleEscalated(task, run, escalating, patch);
      } else if (afkUnresolved) {
        // Clean turn(s) ended but the agent never signalled `finish_task` — not
        // success. Treat as a failure: Auto-Retry within cap, else Escalate. The
        // branch is never merged and the ticket is never closed, so half-done
        // work never lands (#139).
        record('lifecycle', { event: 'unresolved', reason: 'no finish_task signal' });
        this.settleFailedOrRetry(
          task,
          run,
          'run ended without an execution-complete (finish_task) signal',
          patch,
          'agent-finish/unresolved',
        );
      } else if (remergeNeeded) {
        // First-turn ambiguous outcome eligible for a bounded agent re-merge
        // (issue #155): do NOT settle. finalize() has already restored the direct
        // checkout and swept this turn's work into the frozen candidate, so the
        // corrective turn resumes from it. Hand the decision up to the `drive`
        // loop, which dispatches exactly one corrective re-merge turn.
        record('lifecycle', {
          event: 'branch-remerge-needed',
          reason: remergeNeeded.reason,
          detail: remergeNeeded.detail,
        });
        return { kind: 'remerge-needed', reason: remergeNeeded.reason, detail: remergeNeeded.detail };
      } else {
        // Verification gate (issue #135, ADR-0021, reliability-design Unit B):
        // agent-finish begins validation — it does not settle the Run (#114).
        // Enter `verifying` and run the configured verifiers against the frozen
        // candidate. A pass lets the Run proceed toward landing (afk) / review
        // (native). The two non-`proceed` verdicts diverge here (issue #137): an
        // **actionable** fail (`block`) returns up to the `drive` heal loop for a
        // bounded self-heal; an **inconclusive** (`escalate`) never heals and
        // Escalates in place with its cause — so broken work never lands, but a
        // flaky environment is never mistaken for a code defect.
        advancePhase('verifying', autoDriven ? 'auto' : 'human');
        const { decision, ran, autoAccept } = await this.runVerification(
          task,
          run,
          harness,
          active.verifyAbort.signal,
          record,
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
          // Actionable fail (issue #137): the sole heal-eligible verdict. Do NOT
          // settle — hand the failure up to the `drive` heal loop with the failing
          // verifier's output as corrective feedback. `finalize()` already
          // committed this turn's work onto the Run's branch and the candidate ref
          // holds it, so the self-heal turn resumes and fixes it.
          const attempts = this.verificationAttempts.list(run.id);
          const output = attempts[attempts.length - 1]?.output ?? '';
          record('lifecycle', { event: 'verification-actionable-fail', reason: decision.reason });
          return { kind: 'actionable-fail', reason: decision.reason, output };
        } else if (decision.outcome !== 'proceed') {
          // `escalate` = inconclusive (infra doubt: missing command, crashed or
          // malformed verifier, absent candidate). Never a code defect, so it
          // never heals — Escalate immediately with its cause (issue #137).
          const reason = `verification ${decision.outcome}: ${decision.reason}`;
          record('lifecycle', { event: 'escalated', reason });
          this.settleEscalated(task, run, reason, patch);
        } else if (autoDriven) {
          // A mirrored Run has no human gate, so it runs the auto branch:
          // executing → validating → verifying → landing → terminal. The Merge
          // Fate lands the work *and* (for auto-merge) closes the ticket in
          // onCompleted — Harmonic owns the close, only after verify + land
          // (#139). A fate that can't be applied (merge conflict, PR that can't
          // be created, ticket close that fails) Escalates; the ticket is not
          // closed.
          //
          // Deterministic recovery landing (issue #154, reliability-design Unit
          // D): a direct-mode Run executed detached (#152), so its verified work
          // lives only on the frozen candidate — the live intended branch never
          // advanced. When the branch classifier says the outcome is
          // **recoverable**, reconstruct-and-land that candidate here, WITHOUT an
          // agent turn (deterministic recovery is preferred over any re-merge
          // turn), before onCompleted closes the ticket. onCompleted's own
          // auto-merge arm is a no-op for direct mode ("nothing to merge"), so it
          // still owns the close on top of this land.
          //
          // On a CORRECTIVE re-merge turn (issue #155) the land goes through
          // {@link landReMerge} instead: the deterministic classifier can't gate
          // it (the corrective turn inherits the first turn's ref litter), so the
          // pure allowed-set gate — the corrective candidate must reproduce the
          // recorded tree, descend from start, and the branch still contain start
          // — decides land-or-Escalate, with no second mutating turn.
          // Parallel-Epic member land (issue #163): a worktree auto-merge Run
          // whose base is an Epic integration branch (`epic/<ref>`) lands through
          // the single-writer merge train — rebase onto the branch's current tip,
          // ordered per integration branch, with a bounded conflict→heal→escalate
          // — instead of `onCompleted`'s unordered plain merge. This is the one
          // path where two members finishing at once land serially rather than
          // the second one's non-fast-forward merge racing (or falling back).
          const member = this.epicMemberFor(task, this.runStore.get(run.id), workspace);
          if (member) {
            const trainOutcome = remergeCtx
              ? await this.mergeTrain!.onHealComplete(member)
              : await this.mergeTrain!.submit(member);
            if (trainOutcome.status === 'healing') {
              // The coordinator dispatched its one bounded corrective turn (its
              // `dispatchHeal` → enqueueReMergeForMember). Hand up to `drive` to
              // run exactly that turn; its land re-enters via `onHealComplete`.
              record('lifecycle', { event: 'merge-train-heal', integrationBranch: member.integrationBranch });
              return {
                kind: 'merge-train-heal',
                detail:
                  'Your branch no longer rebases cleanly onto the Epic integration branch ' +
                  `(${member.integrationBranch}); reconcile with its latest tip and resolve the conflicts.`,
              };
            }
            if (trainOutcome.status === 'escalated') {
              // The coordinator's `escalate` callback (→ settleEscalatedForMember)
              // already settled the Run; only record + stop here (no double-settle).
              record('lifecycle', { event: 'escalated', reason: trainOutcome.reason });
              return { kind: 'terminal' };
            }
            // landed | already-landed: the work is on the integration branch.
            // Harmonic still owns the ticket close (#139) — the train replaced the
            // merge, not the close.
            if (!(await this.autoDrive!.closeCompleted(task))) {
              record('lifecycle', { event: 'escalated', reason: 'ticket close failed after merge-train land' });
              this.settleEscalated(task, run, 'ticket close failed after merge-train land', patch);
            } else {
              advancePhase('landing', 'auto');
              this.settleAutoCompleted(task, run, patch);
            }
            return { kind: 'terminal' };
          }

          const recovered = remergeCtx
            ? await this.landReMerge(task, run, remergeCtx, record)
            : await this.recoverAndLand(task, run, branchClass, record);
          if (recovered === 'escalate') {
            const reason = remergeCtx
              ? 'agent re-merge did not resolve the branch ambiguity'
              : 'deterministic recovery landing failed';
            record('lifecycle', { event: 'escalated', reason });
            this.settleEscalated(task, run, reason, patch);
          } else {
            const outcome = await this.autoDrive!.onCompleted(task, this.runStore.get(run.id));
            if (outcome === 'escalate') {
              record('lifecycle', { event: 'escalated', reason: 'landing failed' });
              this.settleEscalated(task, run, 'landing failed', patch);
            } else {
              // The Merge Fate landed in onCompleted → record `landing`, then settle
              // terminal (the coordinator marks the Run `phase:'terminal'`).
              advancePhase('landing', 'auto');
              this.settleAutoCompleted(task, run, patch);
            }
          }
        } else if (ran && autoAccept && this.autoAcceptLand) {
          // Native auto-accept (issue #138, ADR-0021): a verifier ran and
          // PASSED, and the resolved config sets auto-accept — the verifier's
          // pass IS the accept, so the Run lands WITHOUT the human review gate:
          // executing → validating → verifying → landing → terminal ('auto' gate).
          // `ran` (not just `outcome === 'proceed'`) is required here — with NO
          // verifier configured `combineVerdicts([])` is also `proceed`, but
          // there's nothing verified to auto-accept, so that case falls through
          // to the human-gated branch below instead.
          advancePhase('landing', 'auto');
          // Re-fetch: `run` (the drive-loop's original parameter) predates
          // `prepareWorkspace` setting branch/baseBranch on the DB row (worktree
          // mode) — mirroring the fresh `this.runStore.get(run.id)` the sibling
          // afk branch above already uses, so `landingEffectsFor` sees the real
          // branch to merge rather than a stale null.
          const landed = await this.autoAcceptLand(task, this.runStore.get(run.id), patch);
          if (!landed.ok) {
            // CRITICAL: `LandingCoordinator.land` writes the land fact + PONC
            // BEFORE the (possibly failing) merge (#115). Calling any settle here
            // would project that already-written land fact and SILENTLY COMPLETE
            // a failed merge (`run-settle.ts` writes the terminal row while the
            // Run is still `running`) — the exact "broken work lands" failure
            // this epic exists to prevent. So do NOT settle here. Degrade to the
            // human gate instead: park in review with the failure as feedback so
            // a human resolves the conflict and re-accepts (landing reconciles
            // the half-applied effect), or the review-SLA sweep (#114) collects
            // it. No silent pass, no lease left wedged.
            record('lifecycle', { event: 'auto-accept-landing-failed', reason: landed.detail ?? 'landing failed' });
            this.parkForReview(task, run, {
              ...patch,
              reviewFeedback: `auto-accept landing failed: ${landed.detail ?? 'merge conflict'}`,
              stat: await this.diffstatFor(task, run.id),
            });
          }
          // landed.ok: `LandingCoordinator.land` (via `autoAcceptLand`) already
          // settled the Run completed + phase terminal and moved the Task to
          // completed — nothing more to do here.
        } else {
          // A native Run is human-gated: no verifier ran, or one ran but
          // auto-accept is off, so a passing verification moves it
          // executing → validating → verifying → review, where it PARKS —
          // non-terminal, holding its Work Context lease — until the human
          // accepts (lands) or rejects it, or its review SLA lapses (#114). It
          // does NOT settle here.
          advancePhase('review', 'human');
          // Snapshot the diffstat once, here, so the awaiting-review board card can
          // show it without an N+1 git spawn per refresh (issue #36).
          this.parkForReview(task, run, { ...patch, stat: await this.diffstatFor(task, run.id) });
        }
      }
      // The turn settled or parked above (escalate / auto-land / auto-accept /
      // human review / unresolved) — a terminal outcome; the heal loop stops.
      // Only the `block` branch returns `actionable-fail`, earlier.
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
        this.settleEscalated(task, run, escalating, patch);
      } else if (autoDriven) {
        // Error failure: Auto-Retry within cap, else Escalate (issue #33).
        this.settleFailedOrRetry(task, run, reason, patch, 'failed');
      } else {
        this.settle(task, run, 'failed', reason, patch);
      }
      // An error failure is terminal — the heal loop does not retry an execution
      // error (only an actionable verification fail heals).
      return { kind: 'terminal' };
    } finally {
      // Disarm the wall-clock watchdog: `driveOnce` is returning, so the Run is
      // leaving every execution phase (parked in review, landing, or settled) —
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
   * The live snapshot for a run's tailer (ADR 0010): parse the harness's
   * native log into rolled-up Usage + Process Tree, plus the root's context
   * fill and the latest current-activity line. null before a session id or
   * a log exists, or for a harness with no Usage Collector.
   */
  private sampleSnapshot(runId: number): RunUsageSnapshot | null {
    const active = this.active.get(runId);
    if (!active) return null;
    const sessionId = this.runStore.get(runId).sessionId;
    if (!sessionId) return null;
    // ponytail: re-parses the whole native log each ~1s tick (parse() has no
    // incremental cursor). Fine for coding-run log sizes; add a tail offset to
    // parse() if a long run's per-second full scan shows up in a profile.
    const parsed = adapterFor(active.harnessId).usage?.parse?.({
      sessionLogDir: active.harness.sessionLogDir,
      cwd: active.cwd,
      sessionId,
    });
    if (!parsed) return null;
    return { usage: parsed.usage, contextTokens: parsed.tree.contextTokens, activity: active.activity, tree: parsed.tree };
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
      return await collectUsageWithRetry({
        harnessId: task.harness,
        harness,
        cwd: workspace.cwd,
        sessionId: this.runStore.get(run.id).sessionId,
        promptResult,
        events: this.runStore.listEvents(run.id),
      });
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
    record: (type: 'session_update' | 'permission_request' | 'lifecycle', payload: unknown) => void,
  ): void {
    const observed = usage ? observedModelMismatch(task.model, usage.models) : null;
    if (observed) record('lifecycle', { event: 'model_mismatch', expected: task.model, observed });
  }

  /**
   * Boot-time healing for the same race: finished runs whose stored
   * usage has no per-model split get one more read of the (now settled)
   * session log. Stored ACP totals win over re-derived ones.
   */
  backfillUsage(): void {
    const config = this.getConfig();
    for (const run of this.runStore.listUsageBackfillCandidates()) {
      try {
        const task = this.taskService.get(run.taskId);
        const harness = config.harnesses[task.harness as keyof typeof config.harnesses];
        if (!harness) continue;
        // Worktree runs executed (and logged) under the worktree path;
        // the directory is gone but the log slug derives from the string.
        const cwd = run.branch ? join(this.worktreesDir, `run-${run.id}`) : task.workingDir;
        const fresh = collectUsage({
          harnessId: task.harness,
          harness,
          cwd,
          sessionId: run.sessionId,
          events: this.runStore.listEvents(run.id),
        });
        if (!fresh || Object.keys(fresh.models).length === 0) continue;
        const stored = run.usage ? (JSON.parse(run.usage) as RunUsage) : null;
        const healed: RunUsage = stored?.totals
          ? { ...fresh, totals: stored.totals, source: 'combined' }
          : fresh;
        this.runStore.update(run.id, { usage: JSON.stringify(healed) });
      } catch {
        // Healing is best-effort; the run keeps its stored usage.
      }
    }
  }

  /** The run's `git diff --stat` at settle time, or null (direct mode, or a
   * git failure — the stat is decoration and must never fail the run). */
  private async diffstatFor(task: TaskRow, runId: number): Promise<string | null> {
    const run = this.runStore.get(runId);
    if (!run.branch || !run.baseBranch) return null;
    try {
      return await Git.diffStat(task.workingDir, run.baseBranch, run.branch);
    } catch {
      return null;
    }
  }

  /**
   * The Runner's settle entry point (issue #113/#114): delegate to the shared
   * {@link RunSettleCoordinator}, which appends the ending-signal `run_fact` and
   * replays the winning disposition by fixed precedence. Extracted so the review
   * gate and the review-SLA sweep settle Runs through the *same* coordinator,
   * with identical race-safety, rather than racing the Runner around the Run row.
   */
  private coordinateSettle(
    task: TaskRow,
    run: RunRow,
    type: RunFactType,
    projection: SettleProjection,
    patch: Partial<RunRow> = {},
  ): void {
    this.settleCoordinator.settle(task, run, type, projection, patch);
  }

  /**
   * Park a human-gated native Run in `phase:'review'` (issue #114). Unlike a
   * settle, this leaves the Run **non-terminal** (`state:'running'`): the result
   * is verified-but-not-yet-landed, and only the human accept (landing), a
   * reject, an operator cancel, or a review-SLA expiry moves it terminal. The
   * Task moves to `awaiting-review` (the human gate), and a review-SLA deadline
   * is stamped so an abandoned review is eventually swept out.
   *
   * The Work Context lease is released here, at review entry — matching today's
   * seam (the lease released at agent-finish before this ticket). Holding the
   * lease across the whole review window is a deliberate follow-up: it needs the
   * phase-specific lease TTLs + heartbeat of #122 (which builds on this phase
   * machine), not the plain release-at-terminal the spine ships today, and
   * blanket-holding it without a TTL would wedge a direct-mode Work Context
   * behind an abandoned review. `patch` carries the run's usage/stopReason/
   * diffstat decoration. Only a still-running Task is moved — a racing cancel
   * that already transitioned it wins.
   */
  private parkForReview(task: TaskRow, run: RunRow, patch: Partial<RunRow>): void {
    this.runStore.update(run.id, { ...patch, phase: 'review', reviewDeadline: Date.now() + REVIEW_SLA_MS });
    try {
      this.leaseStore.releaseByOwner(run.id);
    } catch {
      // best-effort; boot reconciliation is the backstop
    }
    if (this.taskService.get(task.id).state === 'running') {
      this.taskService.setState(task.id, 'awaiting-review');
    }
    // Push the updated Run (phase/stat) to the board; the Task transition already
    // emitted its own change event.
    this.events.onRunFinished?.(this.runStore.get(run.id));
  }

  private settle(
    task: TaskRow,
    run: RunRow,
    state: 'completed' | 'failed',
    reason: string | null,
    patch: Partial<RunRow> = {},
  ): void {
    // A native clean completion is the agent ending its turn (→ awaiting-review);
    // a bare failure is the `failed` disposition (→ Task failed).
    const projection: SettleProjection =
      state === 'completed'
        ? { runState: 'completed', taskAction: 'awaiting-review', reason }
        : { runState: 'failed', taskAction: 'failed', reason };
    const type: RunFactType = state === 'completed' ? 'agent-finish/unresolved' : 'failed';
    this.coordinateSettle(task, run, type, projection, patch);
  }

  /**
   * Clean completion of an afk mirrored Run (issue #33): the Merge Fate +
   * fallback-close already ran in {@link AutoDrive.onCompleted}. Mirrored Tasks
   * bypass the review gate, so the Task goes straight to completed (the poll's
   * closed-ticket reconcile confirms it). Only settle a still-running Task — a
   * racing cancel wins.
   */
  private settleAutoCompleted(task: TaskRow, run: RunRow, patch: Partial<RunRow>): void {
    this.coordinateSettle(
      task,
      run,
      'agent-finish/unresolved',
      { runState: 'completed', taskAction: 'completed', reason: null },
      patch,
    );
  }

  /**
   * A failed afk mirrored Run (issue #33): Auto-Retry re-queues the Task to
   * ready (the Auto-Runner spawns a fresh Run) while within the cap; exhausting
   * it Escalates to a human — never a silent retry beyond the cap. `type`
   * distinguishes a clean-but-unresolved exit (`agent-finish/unresolved`) from
   * an error failure (`failed`) in the fact log; the Task outcome is identical.
   */
  private settleFailedOrRetry(
    task: TaskRow,
    run: RunRow,
    reason: string,
    patch: Partial<RunRow>,
    type: RunFactType,
  ): void {
    const decision = this.autoDrive!.onFailed(task, this.runStore.get(run.id));
    const taskAction: SettleTaskAction = decision === 'retry' ? 'ready' : 'escalate';
    this.coordinateSettle(task, run, type, { runState: 'failed', taskAction, reason }, patch);
  }

  /** Stop an afk Run and hand the Task back to a human (issue #33): Run failed, Task ready + escalated + drive hitl. */
  private settleEscalated(task: TaskRow, run: RunRow, reason: string, patch: Partial<RunRow>): void {
    this.coordinateSettle(task, run, 'escalate', {
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
