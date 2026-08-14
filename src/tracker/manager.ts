import type { WorkspaceRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import type { TrackerAdapter } from './adapter.js';
import { resolveTrackerAdapter } from './adapter.js';
import { MirrorCoordinator } from './coordinator.js';
import { TrackerPoller } from './poller.js';
import type { DerivedMap } from './mirror.js';

interface Entry {
  poller: TrackerPoller;
  mirror: MirrorCoordinator;
  /** `${workingDir}|${intervalMs}` — a change here means tear down and rebuild. */
  sig: string;
}

const sigOf = (ws: WorkspaceRow): string => `${ws.workingDir}|${ws.trackerPollIntervalSeconds * 1000}`;

/**
 * Owns the fleet of per-Workspace tracker poll loops (issue #45). One
 * {@link TrackerPoller} + {@link MirrorCoordinator} per tracker-enabled
 * Workspace, each polling that Workspace's Working Directory into that
 * Workspace's board only. {@link sync} is the single reconcile: it starts a
 * poller when a Workspace enables tracking (or is created with it on), stops
 * one when a Workspace disables tracking or is deleted, and rebuilds one whose
 * repo or interval changed. Callers just mutate Workspaces and call `sync`.
 */
export class TrackerPollerManager {
  private entries = new Map<number, Entry>();

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => WorkspaceRow[],
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onMirrored: () => void = () => {},
    private readonly onError: (msg: string) => void = (msg) => console.error(msg),
  ) {}

  /** Reconcile running pollers to the current set of tracker-enabled Workspaces. Idempotent. */
  sync(): void {
    const wsById = new Map(this.getWorkspaces().map((w) => [w.id, w]));
    // Stop pollers whose Workspace is gone, disabled tracking, or changed its repo/interval.
    for (const [id, entry] of this.entries) {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled || entry.sig !== sigOf(ws)) {
        entry.poller.stop();
        this.entries.delete(id);
      }
    }
    // Start a poller for every tracker-enabled Workspace that lacks one.
    for (const ws of wsById.values()) {
      if (!ws.trackerEnabled || this.entries.has(ws.id)) continue;
      const mirror = new MirrorCoordinator(this.tasks, ws.id);
      const poller = new TrackerPoller(
        this.tasks,
        ws.id,
        ws.workingDir,
        ws.trackerPollIntervalSeconds * 1000,
        this.resolveAdapter,
        this.onMirrored,
        this.onError,
        mirror,
      );
      this.entries.set(ws.id, { poller, mirror, sig: sigOf(ws) });
      poller.start();
    }
  }

  private entryFor(workspaceId: number | null): Entry | undefined {
    return workspaceId === null ? undefined : this.entries.get(workspaceId);
  }

  /** The advisory-assignment coordinator for a Workspace, when it has a running poll loop (issue #32). */
  coordinatorFor(workspaceId: number | null): MirrorCoordinator | undefined {
    return this.entryFor(workspaceId)?.mirror;
  }

  /**
   * Map rollups (D7), each stamped with its Workspace. Scoped to one Workspace
   * when `workspaceId` is given (the board view), else every Workspace's,
   * concatenated — Map refs that collide across repos stay disambiguated by
   * their `workspaceId`.
   */
  maps(workspaceId?: number): DerivedMap[] {
    const entries = workspaceId === undefined ? [...this.entries.values()] : [this.entries.get(workspaceId)];
    return entries.flatMap((e) => e?.poller.maps() ?? []);
  }

  /** The tracker URL for a mirrored Task's ref, scoped to its Workspace's last scan; null otherwise. */
  urlFor(workspaceId: number | null, ref: number | null): string | null {
    return this.entryFor(workspaceId)?.poller.urlFor(ref) ?? null;
  }

  /** A mapRef's title, scoped to its Workspace's last scan; null otherwise (issue #34). */
  titleForMap(workspaceId: number | null, ref: number | null): string | null {
    return this.entryFor(workspaceId)?.poller.titleForMap(ref) ?? null;
  }

  /**
   * Force an immediate poll for a Workspace's tracker — the board's manual
   * refresh. Rescans the repo and mirrors any changes now instead of waiting
   * for the interval. No-op if the Workspace has no running poll loop (tracking
   * off); resolves once the scan + mirror settle, and rejects if the scan fails
   * (unlike the background loop, which swallows) so a manual refresh surfaces it.
   */
  async pollNow(workspaceId: number): Promise<void> {
    await this.entryFor(workspaceId)?.poller.poll();
  }

  /** Stop every poll loop (server shutdown). */
  stopAll(): void {
    for (const entry of this.entries.values()) entry.poller.stop();
    this.entries.clear();
  }
}
