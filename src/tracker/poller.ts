import type { TaskService } from '../domain/tasks.js';
import type { TaskRow } from '../db/schema.js';
import type { ResolvedTracker, Ticket, TrackerAdapter } from './adapter.js';
import { resolutionFailure, resolutionSuccess, resolveTrackerAdapter } from './adapter.js';
import { mirrorScan } from './mirror.js';
import { singleFlight } from '../reliability/single-flight.js';
import { persistedTickets } from './persisted.js';
import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { startOperation, type Operation } from '../telemetry/operations.js';

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
     * The Epic integration-branch reconcile (issue #159). Runs after mirroring
     * so a ready Epic member's `baseBranch` points at its
     * integration branch before the Auto-Runner spawns its worktree Run. Absent
     * ⇒ no Epic integration (today's per-Run behaviour). Its failure is logged,
     * not fatal: mirroring already committed, and an un-set base degrades to the
     * current-branch fallback rather than wedging the poll.
     */
    private readonly epics?: EpicIntegrationSync,
    /**
     * `reconcileOnPoll` (default true): Scheduler-backed deployments set this
     * false and reconcile Epics through their global Job instead. `yieldOptions`
     * lets a large ticket/backlog walk hand the event loop back (issue #200).
     */
    private readonly opts: { reconcileOnPoll?: boolean; yieldOptions?: YieldOptions } = {},
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
    const poll = startOperation({ type: 'poll', attributes: { 'workspace.id': this.workspaceId } });
    try {
      await poll.run(() => this.runPollCycle(poll));
      poll.end();
    } catch (error) {
      poll.fail(error);
      throw error;
    }
  }

  private async runPollCycle(poll: Operation): Promise<void> {
    let adapter: TrackerAdapter;
    try {
      adapter = await this.resolveAdapter(this.workingDir);
    } catch (err) {
      this.onResolved(resolutionFailure(err));
      throw err;
    }
    this.onResolved(resolutionSuccess(adapter));
    poll.update({ 'tracker.name': adapter.name });
    const tickets = await adapter.scan();
    poll.update({ 'tracker.ticket.count': tickets.length });
    this.urlByRef = new Map();
    this.titleByRef = new Map();
    const closedRefs = new Set<number>();
    await forEachYielding(tickets, (ticket) => {
      this.urlByRef.set(ticket.number, ticket.url);
      this.titleByRef.set(ticket.number, ticket.title);
      if (ticket.state === 'closed') closedRefs.add(ticket.number);
    }, this.opts.yieldOptions);
    await this.mirror?.observe(adapter);
    // `!!adapter.close` is the writable-tracker signal (issue #237): an
    // inbound-only adapter with no close capability must not have its completed
    // Tasks flipped back to ready (their tickets stay open by design).
    const mirrored = await mirrorScan(this.tasks, tickets, this.workspaceId, {
      trackerCanClose: !!adapter.close,
      pollSpanContext: poll.spanContext,
    });
    poll.update({ 'tracker.mirrored.count': mirrored.length });
    // Set each ready Epic member's base branch before the scheduler's next pick
    // (issue #159), so it forks its worktree Run from the Epic's integration branch.
    // Best-effort: a git hiccup here must not wedge a poll that already mirrored.
    if (this.epics && (this.opts.reconcileOnPoll ?? true)) {
      const reconcile = startOperation({
        type: 'epic.reconcile',
        attributes: { 'workspace.id': this.workspaceId },
        parent: poll.spanContext,
      });
      try {
        await reconcile.run(() => this.reconcileEpics());
        reconcile.end();
      } catch (err) {
        reconcile.fail(err);
        this.onError(`epic integration reconcile failed: ${String(err)}`);
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
