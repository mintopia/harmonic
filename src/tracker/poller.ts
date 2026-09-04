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

/** The per-Epic integration-branch reconcile, run each poll after mirroring. */
export interface EpicIntegrationSync {
  reconcile(tickets: Ticket[], mirrored: TaskRow[]): Promise<void>;
}

/** One Workspace's tracker mirroring poll loop; its lifecycle is owned by {@link TrackerPollerManager}. */
export class TrackerPoller {
  private timer: NodeJS.Timeout | undefined;
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
    /** Report each cycle's Resolved Tracker. */
    private readonly onResolved: (r: ResolvedTracker) => void = () => {},
    /** Runs after mirroring; absent ⇒ no Epic integration. Its failure is logged, not fatal. */
    private readonly epics?: EpicIntegrationSync,
    /** `reconcileOnPoll` false ⇒ Epics reconcile through the global Scheduler Job instead. */
    private readonly opts: { reconcileOnPoll?: boolean; yieldOptions?: YieldOptions } = {},
  ) {}

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
    const observedAt = Date.now();
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
    const mirrored = await mirrorScan(this.tasks, tickets, this.workspaceId, {
      trackerCanClose: !!adapter.close,
      pollSpanContext: poll.spanContext,
      observedAt,
    });
    poll.update({ 'tracker.mirrored.count': mirrored.length });
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

  /** The Map ticket's title for a mirrored Task's mapRef, from the last scan; null when unmapped or before a poll. */
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

  /** Begin polling on the interval and fire one poll immediately. Idempotent. */
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
