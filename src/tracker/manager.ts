import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { singleFlight } from '../reliability/single-flight.js';
import { InFlight } from '../reliability/in-flight.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ResolvedTracker, TrackerAdapter, WorkspaceTrackerSettings } from './adapter.js';
import { resolveTracker, resolveTrackerAdapter, workspaceTrackerSettings } from './adapter.js';
import { type EpicIntegrateOutcome, type EpicService } from './epic-service.js';
import type { EpicBaseGate } from '../execution/epic-coordinator.js';
import type { Epic } from '../domain/epic-view.js';
import type { Ticket, TrackerRef } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { deriveMaps, type DerivedMap } from './mirror.js';
import { MirrorCoordinator, type TicketCloser } from './coordinator.js';
import { TrackerPoller } from './poller.js';
import { persistedTickets } from './persisted.js';
import type { RepositoryAdapter } from '../repository/adapter.js';
import { resolveRepositoryWithoutSecrets, type RepositoryResolver } from '../repository/resolve.js';

interface Entry { poller: TrackerPoller; mirror: MirrorCoordinator; sig: string; unregister?: () => void }
const sigOf = (workspace: WorkspaceRow): string => `${workspace.workingDir}|${workspace.trackerPollIntervalSeconds * 1000}|${workspace.configuredTracker ?? ''}|${workspace.codeRepository ?? ''}|${workspace.triageLabels ?? ''}`;

export interface TrackerPollerManagerOptions {
  resolveAdapter?: (repoRoot: string, featureIndex?: FeatureIndex, workspace?: WorkspaceTrackerSettings) => Promise<TrackerAdapter>;
  resolveRepository?: RepositoryResolver;
  onError?: (message: string) => void;
  scheduler?: Scheduler;
  epicService: EpicService;
  yieldOptions?: YieldOptions;
  /** Absent means epic reconcile always runs. */
  workStartAllowed?: () => boolean | Promise<boolean>;
  closeTicket?: TicketCloser;
}

/** Owns tracker polling, mirroring, and tracker resolution for each enabled Workspace. */
export class TrackerPollerManager {
  private readonly entries = new Map<number, Entry>();
  private readonly stopping = new InFlight();
  private closed = false;
  private readonly resolved = new Map<number, ResolvedTracker>();
  private readonly epicService: EpicService;
  private readonly resolveAdapter: (repoRoot: string, featureIndex?: FeatureIndex, workspace?: WorkspaceTrackerSettings) => Promise<TrackerAdapter>;
  private readonly resolveRepository: RepositoryResolver;
  private readonly onError: (message: string) => void;
  private readonly scheduler: Scheduler | undefined;
  private readonly yieldOptions: YieldOptions | undefined;
  private readonly workStartAllowed: (() => boolean | Promise<boolean>) | undefined;
  private readonly closeTicket: TicketCloser | undefined;
  readonly sync: () => Promise<void>;

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    options: TrackerPollerManagerOptions,
  ) {
    this.resolveAdapter = options.resolveAdapter ?? resolveTrackerAdapter;
    this.resolveRepository = options.resolveRepository ?? resolveRepositoryWithoutSecrets;
    this.onError = options.onError ?? logger.error;
    this.scheduler = options.scheduler;
    this.epicService = options.epicService;
    this.yieldOptions = options.yieldOptions;
    this.workStartAllowed = options.workStartAllowed;
    this.closeTicket = options.closeTicket;
    // Boot, every workspace POST/PATCH/DELETE, and the workspace watcher all call
    // sync() independently; two overlapping passes both see a not-yet-registered
    // workspace and double-register its Scheduler job. Single-flight it.
    this.sync = singleFlight(() => this.syncOnce());
  }

  private async syncOnce(): Promise<void> {
    const workspaces = new Map((await this.getWorkspaces()).map((workspace) => [workspace.id, workspace]));
    await forEachYielding(this.entries, async ([id, entry]) => { const workspace = workspaces.get(id); if (!workspace || !workspace.trackerEnabled || entry.sig !== sigOf(workspace)) this.stopping.add(this.stopEntry(id, entry), 'trackerManager.stopEntry'); }, this.yieldOptions);
    await forEachYielding(this.resolved.keys(), async (id) => { const workspace = workspaces.get(id); if (!workspace || !workspace.trackerEnabled) this.resolved.delete(id); }, this.yieldOptions);
    await forEachYielding(workspaces.values(), async (workspace) => {
      if (!workspace.trackerEnabled || this.entries.has(workspace.id)) return;
      const resolved = await resolveTracker(workspace.workingDir, (dir) => this.resolveAdapter(dir, undefined, workspaceTrackerSettings(workspace)));
      this.resolved.set(workspace.id, resolved);
      if (resolved.ok || this.scheduler) this.startLoop(workspace);
    }, this.yieldOptions);
  }

  private startLoop(workspace: WorkspaceRow): void {
    if (this.closed) return;
    const mirror = new MirrorCoordinator(this.tasks, workspace.id, this.closeTicket);
    const poller = new TrackerPoller(this.tasks, workspace.id, workspace.workingDir, workspace.trackerPollIntervalSeconds * 1000, (dir) => this.resolveAdapter(dir, (slug) => this.tasks.mdFeatureIndex(workspace.id, slug), workspaceTrackerSettings(workspace)), this.onError, mirror, (resolved) => this.resolved.set(workspace.id, resolved), this.epicService.startWorkspace(workspace), { reconcileOnPoll: this.scheduler === undefined, ...(this.workStartAllowed ? { workStartAllowed: this.workStartAllowed } : {}) });
    const scheduler = this.scheduler;
    if (!scheduler) poller.start();
    const unregister = scheduler?.register({ name: 'Tracker poll', workspaceId: workspace.id, intervalMs: workspace.trackerPollIntervalSeconds * 1000, run: async () => { await poller.poll(); await scheduler.runNow('Epic reconcile'); }, enabled: () => this.resolved.get(workspace.id)?.ok === true });
    this.entries.set(workspace.id, { poller, mirror, sig: sigOf(workspace), ...(unregister ? { unregister } : {}) });
  }

  private async stopEntry(workspaceId: number, entry: Entry): Promise<void> {
    entry.unregister?.();
    this.entries.delete(workspaceId);
    this.epicService.stopWorkspace(workspaceId);
    await entry.poller.stop();
  }
  repositoryFor(workspace: WorkspaceRow): Promise<RepositoryAdapter | null> { return this.resolveRepository(workspace.workingDir, workspaceTrackerSettings(workspace)); }

  adapterFor(workspace: WorkspaceRow): Promise<TrackerAdapter> { return this.resolveAdapter(workspace.workingDir, undefined, workspaceTrackerSettings(workspace)); }
  resolvedTracker(workspaceId: number): ResolvedTracker | null { return this.resolved.get(workspaceId) ?? null; }
  async retryEpic(workspaceId: number, epicRef: TrackerRef, guidance: string, continuation: 'continue' | 'fresh'): Promise<EpicIntegrateOutcome | null> { return this.epicService.retryEpic(workspaceId, epicRef, guidance, continuation); }
  async epicBaseNotReady(task: TaskRow): Promise<EpicBaseGate> { return this.epicService.epicBaseNotReady(task); }
  async refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void> { await this.epicService.refreshAfterDefaultBranchAdvance(workingDir, defaultBranch); }
  async listEpics(workspaceId: number): Promise<Epic[]> { return this.epicService.listEpics(workspaceId); }
  async listEpicTickets(workspaceId: number): Promise<Ticket[]> { return this.epicService.listEpicTickets(workspaceId); }
  async epicDetail(workspaceId: number, epicRef: TrackerRef): Promise<Epic | null> { return this.epicService.epicDetail(workspaceId, epicRef); }
  async epicDiff(workspaceId: number, epicRef: TrackerRef): Promise<string> { return this.epicService.epicDiff(workspaceId, epicRef); }
  coordinatorFor(workspaceId: number | null): MirrorCoordinator | undefined { return workspaceId === null ? undefined : this.entries.get(workspaceId)?.mirror; }

  async maps(workspaceId?: number): Promise<DerivedMap[]> {
    const rows = await this.tasks.list(workspaceId === undefined ? {} : { workspaceId });
    const containers = await this.tasks.listTrackerContainers(workspaceId);
    const byWorkspace = new Map<number, typeof rows>();
    await forEachYielding(rows, (task) => { if (task.origin !== 'mirrored' || task.workspaceId === null) return; const tasks = byWorkspace.get(task.workspaceId); if (tasks) tasks.push(task); else byWorkspace.set(task.workspaceId, [task]); }, this.yieldOptions);
    const containersByWorkspace = new Map<number, typeof containers>();
    await forEachYielding(containers, (container) => { const items = containersByWorkspace.get(container.workspaceId); if (items) items.push(container); else containersByWorkspace.set(container.workspaceId, [container]); if (!byWorkspace.has(container.workspaceId)) byWorkspace.set(container.workspaceId, []); }, this.yieldOptions);
    const maps: DerivedMap[] = [];
    await forEachYielding(byWorkspace, async ([id, mirrored]) => { maps.push(...deriveMaps(await persistedTickets(mirrored, containersByWorkspace.get(id) ?? []), mirrored, id)); }, this.yieldOptions);
    return maps;
  }

  trackerLabelFor(workspaceId: number | null): string | null { const resolved = workspaceId === null ? null : this.resolved.get(workspaceId); return resolved?.ok ? resolved.label : null; }
  urlFor(workspaceId: number | null, ref: TrackerRef | null): string | null { return workspaceId === null ? null : this.entries.get(workspaceId)?.poller.urlFor(ref) ?? null; }
  titleForMap(workspaceId: number | null, ref: TrackerRef | null): string | null { return workspaceId === null ? null : this.entries.get(workspaceId)?.poller.titleForMap(ref) ?? null; }
  async pollNow(workspaceId: number): Promise<void> {
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); if (!workspace || !workspace.trackerEnabled) return;
    const resolved = await resolveTracker(workspace.workingDir, (dir) => this.resolveAdapter(dir, undefined, workspaceTrackerSettings(workspace))); this.resolved.set(workspace.id, resolved); const entry = this.entries.get(workspace.id);
    if (!resolved.ok) { if (!this.scheduler && entry) this.stopping.add(this.stopEntry(workspace.id, entry), 'trackerManager.stopEntry'); return; }
    if (entry) await entry.poller.poll(); else this.startLoop(workspace);
  }
  /** Stop every Workspace loop and wait out polls already in flight. */
  async stopAll(): Promise<void> {
    this.closed = true;
    for (const [id, entry] of this.entries) this.stopping.add(this.stopEntry(id, entry), 'trackerManager.stopEntry');
    await this.stopping.drain();
  }
  async reconcileEpics(): Promise<void> { await forEachYielding(this.entries, async ([id, entry]) => { if (this.resolved.get(id)?.ok) await entry.poller.reconcileEpics(); }, this.yieldOptions); }
}
