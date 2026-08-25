import type { TaskService } from '../domain/tasks.js';
import type { TaskRow } from '../db/schema.js';
import type { ResolvedTracker, Ticket, TrackerAdapter } from './adapter.js';
import { resolutionFailure, resolutionSuccess, resolveTrackerAdapter } from './adapter.js';
import { mirrorScan } from './mirror.js';
import { singleFlight } from '../reliability/single-flight.js';
import { persistedTickets } from './persisted.js';
import { logger } from '../logger.js';

/** The mirror coordinator's poll-side surface: retain the write adapter, then reconcile advisory assignments. */
export interface MirrorSync {
  observe(adapter: TrackerAdapter): Promise<void>;
  reconcile(): Promise<void>;
}

/**
 * The per-Epic integration-branch reconcile (issue #159), run each poll between
 * mirroring so a ready member's `baseBranch` is set before the scheduler's next
 * DB-backed pick. Structurally implemented by the
 * {@link EpicIntegrationCoordinator} in the execution layer.
 */
export interface EpicIntegrationSync {
  reconcile(tickets: Ticket[], mirrored: TaskRow[]): Promise<void>;
}

/**
 * One Workspace's tracker mirroring poll loop (issues #30, #45). Scans this
 * Workspace's `workingDir` repo on a fixed interval and upserts each issue 1:1
 * into a mirrored Task *in this Workspace only*. It is a fact-sync sidecar;
 * scheduling is independent of poll timing. Best-effort: a
 * failed scan is logged and the next tick retries. Lifecycle (start/stop on a
 * Workspace's tracker toggle, dir change, or deletion) is owned by the
 * {@link TrackerPollerManager}, so there is no per-tick enabled check — a
 * running poller always belongs to a tracker-enabled Workspace.
 */
export class TrackerPoller {
  private timer: NodeJS.Timeout | undefined;
  /** Last-poll presentation lookups. Structural derivation reads persisted Task facts. */
  private urlByRef = new Map<number, string>();
  private titleByRef = new Map<number, string>();

  constructor(
    private readonly tasks: TaskService,
    private readonly workspaceId: number,
    private readonly workingDir: string,
    private readonly pollIntervalMs: number,
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onError: (msg: string) => void = logger.error,
    private readonly mirror?: MirrorSync,
    /** Report each cycle's Resolved Tracker so the manager's cache stays fresh at poll time (issue #83). */
    private readonly onResolved: (r: ResolvedTracker) => void = () => {},
    /**
     * A mirrored Task whose ticket has closed in the tracker but which is still
     * `running` on the board. Under the close-after-verify model (issue #139)
     * only Harmonic closes a ticket, and only after verify + land, so a close
     * seen while the Task still runs is premature: the Runner stops the parked
     * agent, reopens the ticket, and Escalates. No-op by default (native-only server).
     */
    private readonly onClosedWhileRunning: (taskId: number) => void = () => {},
    /**
     * The Epic integration-branch reconcile (issue #159). Runs after mirroring
     * so a ready Epic member's `baseBranch` points at its
     * integration branch before the Auto-Runner spawns its worktree Run. Absent
     * ⇒ no Epic integration (today's per-Run behaviour). Its failure is logged,
     * not fatal: mirroring already committed, and an un-set base degrades to the
     * current-branch fallback rather than wedging the poll.
     */
    private readonly epics?: EpicIntegrationSync,
    /** Scheduler-backed deployments reconcile Epics through their global Job. */
    private readonly reconcileOnPoll = true,
  ) {}

  /**
   * One poll cycle: resolve → scan → mirror 1:1 into this Workspace → reconcile
   * advisory assignments (issues #32 and #232). The resolution is
   * reported to {@link onResolved} either way (issue #83) so the Resolved
   * Tracker surface refreshes every poll, not just on the manager's reconcile.
   * `observe` retains the current adapter for later advisory claims. `reconcile`
   * runs after the local state settles.
   *
   * Single-flighted (issue #219): the interval timer and a manual `pollNow`
   * both call here, so a slow scan or a slow Epic-integration git op must not let
   * the next tick start an overlapping pass that re-spawns git for the same work.
   * An overlapping call coalesces into one trailing pass rather than stacking.
   */
  private readonly pollGate = singleFlight(() => this.pollOnce());

  poll(): Promise<void> {
    return this.pollGate();
  }

  private async pollOnce(): Promise<void> {
    let adapter: TrackerAdapter;
    try {
      adapter = await this.resolveAdapter(this.workingDir);
    } catch (err) {
      this.onResolved(resolutionFailure(err));
      throw err;
    }
    this.onResolved(resolutionSuccess(adapter));
    const tickets = await adapter.scan();
    this.urlByRef = new Map(tickets.map((t) => [t.number, t.url]));
    this.titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    await this.mirror?.observe(adapter);
    // `!!adapter.close` is the writable-tracker signal (issue #237): an
    // inbound-only adapter with no close capability must not have its completed
    // Tasks flipped back to ready (their tickets stay open by design).
    const mirrored = await mirrorScan(this.tasks, tickets, this.workspaceId, !!adapter.close);
    // Set each ready Epic member's base branch before the scheduler's next pick
    // (issue #159), so it forks its worktree Run from the Epic's integration branch.
    // Best-effort: a git hiccup here must not wedge a poll that already mirrored.
    if (this.epics && this.reconcileOnPoll) {
      try {
        await this.reconcileEpics();
      } catch (err) {
        this.onError(`epic integration reconcile failed: ${String(err)}`);
      }
    }
    // Backstop: upsertMirrored never moves a Task off `running` (nothing
    // interrupts a live Run), so a ticket closed mid-run (agent-via-skill or an
    // operator) leaves the Task stuck running with a parked agent. Under the
    // close-after-verify model (#139) that close is premature — hand those to the
    // Runner to stop the agent, reopen the ticket, and Escalate.
    const closedRefs = new Set(tickets.filter((t) => t.state === 'closed').map((t) => t.number));
    for (const task of mirrored) {
      if (task.state === 'running' && task.trackerRef != null && closedRefs.has(task.trackerRef)) {
        this.onClosedWhileRunning(task.id);
      }
    }
    await this.mirror?.reconcile();
  }

  /** The tracker URL for a mirrored Task's ref, from the last scan; null for native Tasks or before a poll. */
  urlFor(ref: number | null): string | null {
    return ref === null ? null : (this.urlByRef.get(ref) ?? null);
  }

  /** The Map ticket's title for a mirrored Task's mapRef, from the last scan; null when unmapped or before a poll (issue #34). */
  titleForMap(ref: number | null): string | null {
    return ref === null ? null : (this.titleByRef.get(ref) ?? null);
  }

  /** Reconcile persisted tracker facts into this Workspace's Epic integration state. */
  async reconcileEpics(): Promise<void> {
    if (!this.epics) return;
    const persisted = await persistedTickets(
      await this.tasks.list({ workspaceId: this.workspaceId }),
      await this.tasks.listTrackerContainers(this.workspaceId),
    );
    const mirrored = (await this.tasks.list({ workspaceId: this.workspaceId })).filter((task) => task.origin === 'mirrored');
    await this.epics.reconcile(persisted, mirrored);
  }

  /**
   * Begin polling on this Workspace's interval and fire one poll immediately.
   * Idempotent. The interval is fixed for the poller's life; the manager tears
   * this poller down and builds a fresh one when the Workspace's interval changes.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch((err) => this.onError(String(err))), this.pollIntervalMs);
    this.timer.unref?.();
    void this.poll().catch((err) => this.onError(String(err)));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
