import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { logger } from '../logger.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ResolvedTracker, TrackerAdapter } from './adapter.js';
import { resolveTracker, resolveTrackerAdapter } from './adapter.js';
import { TrackerEpicService, type EpicIntegrateOutcome, type EpicService } from './epic-service.js';
import type { Epic } from '../domain/epic-view.js';
import type { Ticket } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { deriveMaps, type DerivedMap } from './mirror.js';
import { MirrorCoordinator } from './coordinator.js';
import { TrackerPoller } from './poller.js';
import { persistedTickets } from './persisted.js';

interface Entry { poller: TrackerPoller; mirror: MirrorCoordinator; sig: string; unregister: () => void }
const sigOf = (workspace: WorkspaceRow): string => `${workspace.workingDir}|${workspace.trackerPollIntervalSeconds * 1000}`;

/** Owns tracker polling, mirroring, and tracker resolution for each enabled Workspace. */
export class TrackerPollerManager {
  private readonly entries = new Map<number, Entry>();
  private readonly resolved = new Map<number, ResolvedTracker>();
  private readonly epicService: EpicService;
  private readonly resolveAdapter: (repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter>;
  private readonly onError: (message: string) => void;
  private readonly scheduler: Scheduler | undefined;
  private readonly opts: { yieldOptions?: YieldOptions };

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    epicServiceOrResolveAdapter: EpicService | ((repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter>) = resolveTrackerAdapter,
    resolveAdapterOrOnError?: ((repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter>) | ((message: string) => void),
    onErrorOrLegacy?: ((message: string) => void) | unknown,
    scheduler?: Scheduler,
    opts: { yieldOptions?: YieldOptions } = {},
    ..._legacy: unknown[]
  ) {
    if (typeof epicServiceOrResolveAdapter === 'function') {
      this.resolveAdapter = epicServiceOrResolveAdapter;
      this.onError = typeof resolveAdapterOrOnError === 'function' ? resolveAdapterOrOnError as (message: string) => void : logger.error;
      this.epicService = new TrackerEpicService(tasks, getWorkspaces, this.resolveAdapter, this.onError);
      this.scheduler = undefined;
      this.opts = typeof _legacy[0] === 'object' && _legacy[0] !== null ? _legacy[0] as { yieldOptions?: YieldOptions } : {};
      return;
    }
    this.epicService = epicServiceOrResolveAdapter;
    this.resolveAdapter = typeof resolveAdapterOrOnError === 'function' ? resolveAdapterOrOnError as (repoRoot: string, featureIndex?: FeatureIndex) => Promise<TrackerAdapter> : resolveTrackerAdapter;
    this.onError = typeof onErrorOrLegacy === 'function' ? onErrorOrLegacy as (message: string) => void : logger.error;
    this.scheduler = scheduler;
    this.opts = opts;
  }

  async sync(): Promise<void> {
    const workspaces = new Map((await this.getWorkspaces()).map((workspace) => [workspace.id, workspace]));
    await forEachYielding(this.entries, async ([id, entry]) => { const workspace = workspaces.get(id); if (!workspace || !workspace.trackerEnabled || entry.sig !== sigOf(workspace)) this.stopEntry(id, entry); }, this.opts.yieldOptions);
    await forEachYielding(this.resolved.keys(), async (id) => { const workspace = workspaces.get(id); if (!workspace || !workspace.trackerEnabled) this.resolved.delete(id); }, this.opts.yieldOptions);
    await forEachYielding(workspaces.values(), async (workspace) => {
      if (!workspace.trackerEnabled || this.entries.has(workspace.id)) return;
      const resolved = await resolveTracker(workspace.workingDir, this.resolveAdapter);
      this.resolved.set(workspace.id, resolved);
      if (resolved.ok || this.scheduler) this.startLoop(workspace);
    }, this.opts.yieldOptions);
  }

  private startLoop(workspace: WorkspaceRow): void {
    const mirror = new MirrorCoordinator(this.tasks, workspace.id);
    const poller = new TrackerPoller(this.tasks, workspace.id, workspace.workingDir, workspace.trackerPollIntervalSeconds * 1000, (dir) => this.resolveAdapter(dir, (slug) => this.tasks.mdFeatureIndex(workspace.id, slug)), this.onError, mirror, (resolved) => this.resolved.set(workspace.id, resolved), this.epicService.startWorkspace(workspace), { reconcileOnPoll: this.scheduler === undefined });
    const unregister = this.scheduler
      ? this.scheduler.register({ name: 'Tracker poll', workspaceId: workspace.id, intervalMs: workspace.trackerPollIntervalSeconds * 1000, run: async () => { await poller.poll(); await this.scheduler!.runNow('Epic reconcile'); }, enabled: () => this.resolved.get(workspace.id)?.ok === true })
      : (poller.start(), () => poller.stop());
    this.entries.set(workspace.id, { poller, mirror, sig: sigOf(workspace), unregister });
  }

  private stopEntry(workspaceId: number, entry: Entry): void { entry.poller.stop(); entry.unregister(); this.entries.delete(workspaceId); this.epicService.stopWorkspace(workspaceId); }
  resolvedTracker(workspaceId: number): ResolvedTracker | null { return this.resolved.get(workspaceId) ?? null; }
  async forceIntegrateEpic(workspaceId: number, epicRef: number): Promise<EpicIntegrateOutcome | null> { return this.epicService.forceIntegrateEpic(workspaceId, epicRef); }
  async epicBaseNotReady(task: TaskRow): Promise<boolean> { return this.epicService.epicBaseNotReady(task); }
  async refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void> { await this.epicService.refreshAfterDefaultBranchAdvance(workingDir, defaultBranch); }
  async listEpics(workspaceId: number): Promise<Epic[]> { return this.epicService.listEpics(workspaceId); }
  async listEpicTickets(workspaceId: number): Promise<Ticket[]> { return this.epicService.listEpicTickets(workspaceId); }
  async epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null> { return this.epicService.epicDetail(workspaceId, epicRef); }
  async epicDiff(workspaceId: number, epicRef: number): Promise<string> { return this.epicService.epicDiff(workspaceId, epicRef); }
  coordinatorFor(workspaceId: number | null): MirrorCoordinator | undefined { return workspaceId === null ? undefined : this.entries.get(workspaceId)?.mirror; }

  async maps(workspaceId?: number): Promise<DerivedMap[]> {
    const rows = await this.tasks.list(workspaceId === undefined ? {} : { workspaceId });
    const containers = await this.tasks.listTrackerContainers(workspaceId);
    const byWorkspace = new Map<number, typeof rows>();
    await forEachYielding(rows, (task) => { if (task.origin !== 'mirrored' || task.workspaceId === null) return; const tasks = byWorkspace.get(task.workspaceId); if (tasks) tasks.push(task); else byWorkspace.set(task.workspaceId, [task]); });
    const containersByWorkspace = new Map<number, typeof containers>();
    await forEachYielding(containers, (container) => { const items = containersByWorkspace.get(container.workspaceId); if (items) items.push(container); else containersByWorkspace.set(container.workspaceId, [container]); if (!byWorkspace.has(container.workspaceId)) byWorkspace.set(container.workspaceId, []); });
    const maps: DerivedMap[] = [];
    await forEachYielding(byWorkspace, async ([id, mirrored]) => { maps.push(...deriveMaps(await persistedTickets(mirrored, containersByWorkspace.get(id) ?? []), mirrored, id)); });
    return maps;
  }

  urlFor(workspaceId: number | null, ref: number | null): string | null { return workspaceId === null ? null : this.entries.get(workspaceId)?.poller.urlFor(ref) ?? null; }
  titleForMap(workspaceId: number | null, ref: number | null): string | null { return workspaceId === null ? null : this.entries.get(workspaceId)?.poller.titleForMap(ref) ?? null; }
  async pollNow(workspaceId: number): Promise<void> {
    const workspace = (await this.getWorkspaces()).find((candidate) => candidate.id === workspaceId); if (!workspace || !workspace.trackerEnabled) return;
    const resolved = await resolveTracker(workspace.workingDir, this.resolveAdapter); this.resolved.set(workspace.id, resolved); const entry = this.entries.get(workspace.id);
    if (!resolved.ok) { if (!this.scheduler && entry) this.stopEntry(workspace.id, entry); return; }
    if (entry) await entry.poller.poll(); else this.startLoop(workspace);
  }
  stopAll(): void { for (const [id, entry] of this.entries) this.stopEntry(id, entry); }
  async reconcileEpics(): Promise<void> { await forEachYielding(this.entries, async ([id, entry]) => { if (this.resolved.get(id)?.ok) await entry.poller.reconcileEpics(); }); }
}
