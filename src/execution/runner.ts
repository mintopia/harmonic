import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from './git.js';
import { adapterFor } from './harness/adapter.js';
import { collectUsage, collectUsageWithRetry, observedModelMismatch, activityLine, type RunUsage, type RunUsageSnapshot } from './usage.js';
import { LiveUsageTailer, type TailerCadence } from './live-usage-tailer.js';
import { promptForTask } from './run-prompt.js';
import type { AutoDrive } from './auto-drive.js';
import type { AppConfig, HarnessConfig } from '../config.js';
import type { TaskRow, RunRow, WorkspaceRow } from '../db/schema.js';
import { AcpDriver } from '../acp/driver.js';
import { DomainError } from '../domain/errors.js';
import type { RunStore, PersistedRunEvent, RunGuardrailSnapshot } from '../domain/runs.js';
import { RunFactStore } from '../domain/run-facts.js';
import { LandingJournalStore } from '../domain/landing-journal.js';
import type { SettleProjection, SettleTaskAction } from '../domain/run-coordinator.js';
import { RunSettleCoordinator } from '../domain/run-settle.js';
import { phasePath, type RunPhase, type ReviewGate } from '../domain/run-phases.js';
import type { RunFactType } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveGuardrails } from '../domain/setting-override.js';
import { resolvePrices } from './pricing.js';
import { workContextKey } from '../domain/work-context-key.js';
import type { WorkContextLeaseStore } from '../domain/work-context-leases.js';
import type { Db } from '../db/index.js';

/** How much harness stderr to keep for a failure reason — the tail, since
 * the fatal message is last. Bounds an otherwise unbounded buffer. */
const STDERR_TAIL_CAP = 8000;

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
  /** Resolves a Task's Workspace row for the Guardrail snapshot (issue #126);
   * absent → the snapshot resolves against global defaults only. */
  getWorkspace?: (workspaceId: number | null) => Pick<WorkspaceRow, 'guardrailBudget' | 'guardrailProgress'> | undefined;
}

interface Workspace {
  cwd: string;
  env: Record<string, string>;
  worktree?: { repoDir: string; path: string };
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
   * prompts — not mid-tool-call. The board-refresh backstop
   * ({@link Runner.completeClosedMirrored}) only stops an agent that has ended
   * its turn, so it never SIGKILLs one mid-work. False during a prompt turn and
   * once the Run leaves the continue loop to settle.
   */
  idle: boolean;
  /**
   * Latched by {@link Runner.completeClosedMirrored} when the poll settles this
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
}

/**
 * Spawns a task's harness, drives it over ACP, persists every
 * session/update as a run event, and settles the task's state from the
 * outcome. One prompt turn per run.
 */
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
  private readonly runFacts: RunFactStore;
  /** The shared terminal-disposition coordinator (issue #113/#114): every Run
   * settle — drive-loop, operator cancel/complete, review-parked — funnels here
   * so the winning disposition is decided by precedence, once. */
  private readonly settleCoordinator: RunSettleCoordinator;
  private readonly tailer: LiveUsageTailer;
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
    this.runFacts = new RunFactStore(this.db);
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
      const created = this.runStore.create(task.id, snapshot);
      this.leaseStore.acquire(this.workContextKeyFor(task, created), created.id, 'running');
      return created;
    });
    void this.drive(task, run, harness).catch(() => {});
    return run;
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
   * still `running`). Unlike {@link completeClosedMirrored} this does not wait
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
   * Board-refresh backstop. A mirrored Task's tracker ticket has closed while the
   * Task is still `running` and its agent is parked between turns (it ended a turn
   * without finishing). The continue loop's own {@link AutoDrive.isResolved} check
   * reads a single ticket and can lag the poll's authoritative scan, so a parked
   * agent would keep burning continue budget against an already-done ticket. When
   * the poll sees the close, stop the agent and settle the Task `completed` — the
   * same terminal state {@link settleAutoCompleted} reaches, consistent with
   * ADR-0011 (the ticket *is* closed).
   *
   * When an agent *is* attached, no-op unless its turn has ended (`idle`): a
   * mid-turn agent is left to finish (its own loop or the next poll settles it),
   * never SIGKILLed mid-tool-call. Fully synchronous, so it runs atomically
   * against {@link drive}'s await points; `drive` then sees `externallySettled`
   * and skips its own settle.
   *
   * When *no* agent is attached — the Task is still `running` on the board but no
   * Run is driving it (a Run that ended without settling, or a pick that flipped
   * the Task running against a since-closed ticket) — there is nothing to stop, so
   * settle the Task `completed` directly. Guarded on there being no live Run row:
   * between a Run's ready→running flip (the pick's lock) or its spawn and its
   * {@link ActiveRun} landing in {@link active}, the Task is momentarily `running`
   * with no active Run — a live Run is imminent, so leave it to that Run (or the
   * next poll) rather than settle out from under it. Returns whether it acted.
   */
  completeClosedMirrored(taskId: number): boolean {
    for (const active of this.active.values()) {
      if (active.taskId !== taskId) continue;
      if (active.externallySettled || !active.idle) return false; // mid-turn or already settling
      active.externallySettled = true;
      // Flush the final usage snapshot before the log's cwd (worktree) is torn down.
      this.tailer.stop(active.runId);
      const run = this.runStore.get(active.runId);
      const task = this.taskService.get(taskId);
      // The ticket is closed (ADR-0011): settle the parked agent's Run complete.
      // taskAction 'completed' only lands a still-running Task — a racing
      // cancel/escalate that already moved it wins.
      this.coordinateSettle(task, run, 'agent-finish/unresolved', {
        runState: 'completed',
        taskAction: 'completed',
        reason: null,
      });
      this.kill(active); // stop the parked agent; drive() finalizes the worktree + keys
      return true;
    }
    // No agent is working this Task. Settle it done anyway (the ticket is closed;
    // ADR-0011) — but only a still-running Task with no live Run in flight, so we
    // never race a Run that is mid-spawn (its ActiveRun not yet registered).
    if (this.taskService.get(taskId).state !== 'running') return false;
    if (this.runStore.listForTask(taskId).some((r) => r.state === 'running')) return false;
    this.taskService.setState(taskId, 'completed');
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
   * Direct mode runs in place, unlocked. Worktree mode gets a temporary
   * git worktree on branch `harmonic/task-<id>-run-<n>` cut from the
   * working directory's current branch.
   */
  private async prepareWorkspace(task: TaskRow, run: RunRow): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') return { cwd: task.workingDir, env: {} };

    const baseBranch = await Git.currentBranch(task.workingDir);
    const branch = `harmonic/task-${task.id}-run-${run.attempt}`;
    const path = join(this.worktreesDir, `run-${run.id}`);
    mkdirSync(this.worktreesDir, { recursive: true });
    await Git.addWorktree(task.workingDir, path, branch);
    this.runStore.update(run.id, { branch, baseBranch });
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path } };
  }

  /**
   * Snapshot the run's work onto its branch and drop the worktree; the
   * branch remains as the artifact. Runs before the task settles so an
   * awaiting-review task always has a reviewable branch.
   */
  private async finalizeWorkspace(task: TaskRow, run: RunRow, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    try {
      await Git.commitAll(workspace.worktree.path, `harmonic: task ${task.id} run ${run.attempt}`);
    } finally {
      await Git.removeWorktree(workspace.worktree.repoDir, workspace.worktree.path).catch(() => {});
    }
  }

  private async drive(task: TaskRow, run: RunRow, harness: HarnessConfig): Promise<void> {
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

    let child: ChildProcess;
    let workspace: Workspace;
    let mcpServers: unknown[] = [];
    // A harness that dies without a clean ACP error (codex-acp exiting
    // non-zero mid-handshake) explains itself only on stderr. Retain its
    // tail so the failure reason carries the cause, not a bare exit code;
    // draining the pipe also prevents backpressure on a chatty process.
    let stderrTail = '';
    let stderrFlushed: Promise<void> = Promise.resolve();
    try {
      workspace = await this.prepareWorkspace(task, run);
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
      this.settle(task, run, 'failed', err instanceof Error ? err.message : String(err));
      return;
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
      onSessionUpdate: (update) => record('session_update', update),
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
    };
    this.active.set(run.id, active);

    try {
      // Harnesses with no reliable spawn-time pin (copilot) pin per
      // session instead — sent for every run, `auto` included, because an
      // unpinned session inherits the operator's persisted model choice
      // (issue 25). A rejected pin fails the run like any other request.
      const modelId = adapterFor(task.harness).sessionModelId?.(task.model);
      await driver.handshake({
        cwd: workspace.cwd,
        mcpServers,
        modelId,
        // Persist the id before the optional model pin, so a failed pin
        // still leaves a session for usage backfill.
        onSessionCreated: (sessionId) => this.runStore.update(run.id, { sessionId }),
      });

      // The session id is persisted; start tailing its native log (ADR 0010).
      this.tailer.start(run.id);

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
      // Persist the exact text sent so Task detail can show it on every Run —
      // native or mirrored — without re-deriving a template that may since have
      // changed (the "Prompt" tab reads this column). Steer/continue turns are
      // recorded as lifecycle events, not folded into this initial prompt.
      this.runStore.update(run.id, { prompt: promptText });
      let result = await driver.prompt([{ type: 'text', text: promptText }]);
      active.idle = true; // turn ended → parked; the backstop may settle a closed ticket here
      // Steering + auto-drive continue loop. `attempt` counts only auto-drive
      // continue nudges, so operator steers never eat into the continue budget.
      for (let attempt = 1; !escalating; ) {
        if (active.externallySettled) break; // the poll settled a closed ticket while parked
        if (active.escalateReason) {
          escalating = active.escalateReason; // agent asked for a human → settle Escalated
          break;
        }
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
        if (active.agentFinished) break; // explicit finish signal
        if (await this.autoDrive!.isResolved(task)) break; // ticket closed
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
        return;
      }

      record('lifecycle', { event: 'finished', stopReason: result.stopReason ?? null });
      await finalize();
      const usage = await this.collectUsageSafe(task, run, harness, workspace, result);
      this.noteModelMismatch(task, usage, record);
      const patch = { stopReason: result.stopReason ?? null, usage: usage ? JSON.stringify(usage) : null };
      if (escalating) {
        record('lifecycle', { event: 'escalated', reason: escalating });
        this.settleEscalated(task, run, escalating, patch);
      } else if (autoDriven) {
        // Agent-finish begins validation — it does not settle the Run (#114).
        // A mirrored Run has no human gate, so it runs the auto branch:
        // executing → validating → verifying → landing → terminal.
        advancePhase('verifying', 'auto');
        const outcome = await this.autoDrive!.onCompleted(task, this.runStore.get(run.id));
        if (outcome === 'escalate') {
          record('lifecycle', { event: 'escalated', reason: 'merge conflict' });
          this.settleEscalated(task, run, 'merge conflict', patch);
        } else if (outcome === 'unresolved') {
          // Clean exit but the agent never closed the ticket — not success.
          // Treat as a failure: Auto-Retry within cap, else Escalate.
          record('lifecycle', { event: 'unresolved', reason: 'ticket left open' });
          this.settleFailedOrRetry(
            task,
            run,
            'run ended without resolving the ticket (left open)',
            patch,
            'agent-finish/unresolved',
          );
        } else {
          // The Merge Fate landed in onCompleted → record `landing`, then settle
          // terminal (the coordinator marks the Run `phase:'terminal'`).
          advancePhase('landing', 'auto');
          this.settleAutoCompleted(task, run, patch);
        }
      } else {
        // A native Run is human-gated: agent-finish moves it executing →
        // validating → verifying → review, where it PARKS — non-terminal,
        // holding its Work Context lease — until the human accepts (lands) or
        // rejects it, or its review SLA lapses (#114). It does NOT settle here.
        advancePhase('review', 'human');
        // Snapshot the diffstat once, here, so the awaiting-review board card can
        // show it without an N+1 git spawn per refresh (issue #36).
        this.parkForReview(task, run, { ...patch, stat: await this.diffstatFor(task, run.id) });
      }
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      // Let stderr finish flushing (the process has exited, so 'end' is
      // imminent) before reading its tail, capped so a hang can't wait.
      await Promise.race([stderrFlushed, new Promise((r) => setTimeout(r, 500))]);
      const tail = stderrTail.trim();
      const reason = tail ? `${base}\n\nharness stderr:\n${tail}` : base;
      await finalize();
      // The poll may have stopped a parked agent on a closed ticket; that Run is
      // already settled completed, so don't re-settle it as failed.
      if (active.externallySettled) return;
      // Process/server shutdown SIGKILLed the harness — this is not a run
      // failure. Leave the Run `running` so boot reconciliation settles it
      // interrupted (process-death), not a spurious "harness exited" failure.
      if (this.shuttingDown) return;
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
    } finally {
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
