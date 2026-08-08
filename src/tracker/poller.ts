import type { AppConfig } from '../config.js';
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
 * The tracker mirroring poll loop (issue #30). While enabled, scans the
 * `defaults.workingDir` repo's tracker on an interval and upserts each issue
 * 1:1 into a mirrored Task, then pokes downstream (the Auto-Runner) so any
 * newly-ready mirrored Task gets picked up. Best-effort: a failed scan is
 * logged and the next tick retries. The `enabled` check runs before the
 * adapter is resolved, so a disabled poller never touches the tracker.
 */
export class TrackerPoller {
  private timer: NodeJS.Timeout | undefined;
  /** The last poll's scan — the "polled tracker" the Map rollup and Task urls read (D7). Empty before the first poll. */
  private lastScan: Ticket[] = [];
  private urlByRef = new Map<number, string>();
  private titleByRef = new Map<number, string>();

  constructor(
    private readonly tasks: TaskService,
    private readonly getConfig: () => AppConfig,
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onMirrored: () => void = () => {},
    private readonly onError: (msg: string) => void = (msg) => console.error(msg),
    private readonly mirror?: MirrorSync,
  ) {}

  /**
   * One poll cycle: scan → cache for picks → mirror 1:1 → poke → reconcile
   * assignments (issue #32). No-op (and no adapter resolve) when disabled.
   * `observe` runs before the poke so a freshly-mirrored Task's pick sees the
   * current assignees; `reconcile` runs after so it settles against final state.
   */
  async poll(): Promise<void> {
    if (!this.getConfig().tracker.enabled) return;
    const adapter = await this.resolveAdapter(this.getConfig().defaults.workingDir);
    const tickets = await adapter.scan();
    this.lastScan = tickets;
    this.urlByRef = new Map(tickets.map((t) => [t.number, t.url]));
    this.titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    await this.mirror?.observe(adapter, tickets);
    mirrorScan(this.tasks, tickets);
    this.onMirrored();
    await this.mirror?.reconcile();
  }

  /**
   * Query-time Map rollup (D7): each Map from the last scan paired with the
   * mirrored Tasks that point at it. Not stored — recomputed per call from the
   * last poll's scan and the current mirrored Tasks. Empty before the first poll.
   */
  maps(): DerivedMap[] {
    return deriveMaps(this.lastScan, this.tasks.list().filter((t) => t.origin === 'mirrored'));
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
   * Begin polling on the configured interval and fire one poll immediately.
   * Idempotent. The interval is read once here; a changed `pollIntervalSeconds`
   * takes effect on restart — but toggling `enabled` works live, since each
   * tick re-checks it.
   * ponytail: fixed interval, restart to change cadence — add a live re-read if operators ask.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch((err) => this.onError(String(err))), this.getConfig().tracker.pollIntervalSeconds * 1000);
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
