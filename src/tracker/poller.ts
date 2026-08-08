import type { TaskService } from '../domain/tasks.js';
import type { Ticket, TrackerAdapter } from './adapter.js';
import { resolveTrackerAdapter } from './adapter.js';
import { deriveMaps, mirrorScan, type DerivedMap } from './mirror.js';

/** The mirror coordinator's poll-side surface (issue #32): cache the scan for picks, then reconcile assignments. */
export interface MirrorSync {
  observe(adapter: TrackerAdapter, scan: Ticket[]): Promise<void>;
  reconcile(): Promise<void>;
}

/**
 * One Workspace's tracker mirroring poll loop (issues #30, #45). Scans this
 * Workspace's `workingDir` repo on a fixed interval and upserts each issue 1:1
 * into a mirrored Task *in this Workspace only*, then pokes downstream (the
 * Auto-Runner) so any newly-ready mirrored Task gets picked up. Best-effort: a
 * failed scan is logged and the next tick retries. Lifecycle (start/stop on a
 * Workspace's tracker toggle, dir change, or deletion) is owned by the
 * {@link TrackerPollerManager}, so there is no per-tick enabled check — a
 * running poller always belongs to a tracker-enabled Workspace.
 */
export class TrackerPoller {
  private timer: NodeJS.Timeout | undefined;
  /** The last poll's scan — the "polled tracker" the Map rollup and Task urls read (D7). Empty before the first poll. */
  private lastScan: Ticket[] = [];
  private urlByRef = new Map<number, string>();
  private titleByRef = new Map<number, string>();

  constructor(
    private readonly tasks: TaskService,
    private readonly workspaceId: number,
    private readonly workingDir: string,
    private readonly pollIntervalMs: number,
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onMirrored: () => void = () => {},
    private readonly onError: (msg: string) => void = (msg) => console.error(msg),
    private readonly mirror?: MirrorSync,
  ) {}

  /**
   * One poll cycle: scan → cache for picks → mirror 1:1 into this Workspace →
   * poke → reconcile assignments (issue #32). `observe` runs before the poke so
   * a freshly-mirrored Task's pick sees the current assignees; `reconcile` runs
   * after so it settles against final state.
   */
  async poll(): Promise<void> {
    const adapter = await this.resolveAdapter(this.workingDir);
    const tickets = await adapter.scan();
    this.lastScan = tickets;
    this.urlByRef = new Map(tickets.map((t) => [t.number, t.url]));
    this.titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    await this.mirror?.observe(adapter, tickets);
    mirrorScan(this.tasks, tickets, this.workspaceId);
    this.onMirrored();
    await this.mirror?.reconcile();
  }

  /**
   * Query-time Map rollup (D7): each Map from the last scan paired with the
   * mirrored Tasks that point at it. Not stored — recomputed per call from the
   * last poll's scan and this Workspace's mirrored Tasks. Empty before the first poll.
   */
  maps(): DerivedMap[] {
    return deriveMaps(
      this.lastScan,
      this.tasks.list({ workspaceId: this.workspaceId }).filter((t) => t.origin === 'mirrored'),
      this.workspaceId,
    );
  }

  /** The tracker URL for a mirrored Task's ref, from the last scan; null for native Tasks or before a poll. */
  urlFor(ref: number | null): string | null {
    return ref === null ? null : (this.urlByRef.get(ref) ?? null);
  }

  /** The Map ticket's title for a mirrored Task's mapRef, from the last scan; null when unmapped or before a poll (issue #34). */
  titleForMap(ref: number | null): string | null {
    return ref === null ? null : (this.titleByRef.get(ref) ?? null);
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
