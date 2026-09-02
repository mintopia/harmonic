import type { EpicRow, TaskRow, WorkspaceRow } from '../db/schema.js';
import type { AppConfig } from '../config.js';
import type { TaskService, TaskWithDeps } from '../domain/tasks.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import type { ResolvedTracker, Ticket, TrackerAdapter } from './adapter.js';
import { resolveTracker, resolveTrackerAdapter } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { MirrorCoordinator } from './coordinator.js';
import { TrackerPoller } from './poller.js';
import { deriveMaps, type DerivedMap } from './mirror.js';
import { recordAndCloseIntegratedEpic } from './epic-close.js';
import { EpicIntegrationCoordinator, integrationBranchName } from '../execution/epic-integration.js';
import { EpicIntegrateCoordinator, type EpicIntegrateOutcome } from '../execution/epic-integrate-git.js';
import { verifyEpicIntegration } from '../execution/epic-verification.js';
import { EpicOperations } from '../execution/epic-operations.js';
import { resolveRepositoryDefaultBranch } from '../execution/branch-merge.js';
import { Git } from '../execution/git.js';
import {
  EpicRefreshCoordinator,
  type EpicRefreshResolveDispatchOutcome,
  type EpicRefreshTarget,
} from '../execution/epic-refresh-coordinator.js';
import type { MergePolicyOutcome, PostMergeCheckResult } from '../execution/merge-policy.js';

/** Integrate an Epic's `epic/<ref>` branch into the default branch under the one merge policy; `runPostMergeCheck` re-runs the Workspace's whole-Epic verifiers on the merged tip. */
export type MergeEpicIntegration = (input: {
  repoDir: string;
  epicRef: number;
  defaultBranch: string;
  integrationBranch: string;
  runPostMergeCheck: (mergeOid: string, baseDir: string) => Promise<PostMergeCheckResult>;
}) => Promise<MergePolicyOutcome>;
import { deriveLeafEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts, type EpicMeta } from '../domain/epic-view.js';
import { persistedTickets } from './persisted.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { logger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';

interface Entry {
  poller: TrackerPoller;
  mirror: MirrorCoordinator;
  epics: EpicIntegrationCoordinator;
  epicIntegrate?: EpicIntegrateCoordinator;
  sig: string;
  unregister: () => void;
}

const sigOf = (ws: WorkspaceRow): string => `${ws.workingDir}|${ws.trackerPollIntervalSeconds * 1000}`;

function historicalEpicTicket(epic: DerivedEpic): Ticket {
  return {
    number: epic.ref,
    title: epic.title,
    state: 'closed',
    labels: [],
    parent: null,
    blockedBy: [],
    body: '',
    createdAt: '',
    closedAt: null,
    assignees: [],
    blocking: [],
    comments: [],
    isMap: false,
    url: '',
  };
}

/** Owns one {@link TrackerPoller} + {@link MirrorCoordinator} per tracker-enabled Workspace; {@link sync} is the single reconcile. */
export class TrackerPollerManager {
  private entries = new Map<number, Entry>();
  private resolved = new Map<number, ResolvedTracker>();

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    private readonly resolveAdapter: (
      repoRoot: string,
      featureIndex?: FeatureIndex,
    ) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onError: (msg: string) => void = logger.error,
    /** Read per poll to resolve a Workspace's verifiers for the whole-Epic integrate; absent ⇒ no automatic whole-Epic integrate. */
    private readonly getConfig?: () => Pick<AppConfig, 'verify'>,
    private readonly epicOperations: EpicOperations = new EpicOperations(),
    private readonly scheduler?: Scheduler,
    private readonly opts: { yieldOptions?: YieldOptions } = {},
    /** Absent ⇒ no automatic whole-Epic integrate is wired. */
    private readonly mergeEpicIntegration?: MergeEpicIntegration,
    private readonly dispatchEpicRefreshResolution: (
      target: EpicRefreshTarget,
      detail: string,
      escalate: (epicRef: number, reason: string) => void,
      retry: () => Promise<unknown>,
    ) => Promise<EpicRefreshResolveDispatchOutcome> = async () => ({ status: 'dispatched' }),
  ) {}

  /** Reconcile Scheduler-owned tracker Jobs to the current tracker-enabled Workspaces; an unresolvable Workspace keeps a disabled Job. */
  async sync(): Promise<void> {
    const wsById = new Map((await this.getWorkspaces()).map((w) => [w.id, w]));
    await forEachYielding(this.entries, async ([id, entry]) => {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled || entry.sig !== sigOf(ws)) {
        entry.poller.stop();
        entry.unregister();
        this.entries.delete(id);
      }
    }, this.opts.yieldOptions);
    await forEachYielding(this.resolved.keys(), async (id) => {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled) this.resolved.delete(id);
    }, this.opts.yieldOptions);
    await forEachYielding(wsById.values(), async (ws) => {
      if (!ws.trackerEnabled || this.entries.has(ws.id)) return;
      const resolved = await resolveTracker(ws.workingDir, this.resolveAdapter);
      this.resolved.set(ws.id, resolved);
      if (resolved.ok || this.scheduler) this.startLoop(ws);
    }, this.opts.yieldOptions);
  }

  private startLoop(ws: WorkspaceRow): void {
    const mirror = new MirrorCoordinator(this.tasks, ws.id);
    const epics = new EpicIntegrationCoordinator(this.tasks, ws.workingDir);
    epics.attachOperations(this.epicOperations);
    let epicIntegrate: EpicIntegrateCoordinator | undefined;
    const getConfig = this.getConfig;
    const mergeEpicIntegration = this.mergeEpicIntegration;
    if (getConfig && mergeEpicIntegration) {
      const resolveWorkspaceVerifiers = async () => {
        const live = (await this.getWorkspaces()).find((w) => w.id === ws.id) ?? ws;
        return resolveVerifiers(live, getConfig());
      };
      epicIntegrate = new EpicIntegrateCoordinator({
        repoDir: ws.workingDir,
        verify: async ({ repoDir, verifiedHeadOid }) =>
          verifyEpicIntegration({ repoDir, verifiedHeadOid, verifiers: await resolveWorkspaceVerifiers() }),
        integrate: ({ repoDir, epicRef, defaultBranch, integrationBranch }) =>
          mergeEpicIntegration({
            repoDir,
            epicRef,
            defaultBranch,
            integrationBranch,
            runPostMergeCheck: async (mergeOid) => {
              const decision = await verifyEpicIntegration({
                repoDir,
                verifiedHeadOid: mergeOid,
                verifiers: await resolveWorkspaceVerifiers(),
              });
              return { pass: decision.outcome === 'proceed', output: decision.outcome === 'proceed' ? '' : decision.reason };
            },
          }),
        retire: (epicRef) => epics.retireIntegrationBranch(epicRef),
        escalate: (epicRef, reason) => this.onError(`epic ${epicRef} whole-Epic integrate escalated: ${reason}`),
        operations: this.epicOperations,
        recordIntegration: ({ epicRef, mergeCommit, memberRefs }) =>
          recordAndCloseIntegratedEpic({
            epicRef,
            settle: () => this.tasks.markEpicIntegrated(ws.id, epicRef, { mergeCommit, memberRefs }),
            resolveAdapter: () => this.resolveAdapter(ws.workingDir, (slug) => this.tasks.mdFeatureIndex(ws.id, slug)),
            onError: this.onError,
          }),
      });
      epics.attachIntegrateTrigger(epicIntegrate);
    }
    {
      const noteRefreshBehind = (ref: number, reason: string): void => {
        if (epicIntegrate) epicIntegrate.recordRefreshBehind(ref, reason);
        else logger.debug(`epic ${ref} integration refresh behind develop (retrying): ${reason}`);
      };
      const refresh: EpicRefreshCoordinator = new EpicRefreshCoordinator({
        dispatchResolve: (target, detail) =>
          this.dispatchEpicRefreshResolution(target, detail, noteRefreshBehind, () => refresh.refresh(target)),
        escalate: noteRefreshBehind,
      });
      epics.attachRefreshTrigger(refresh);
    }
    const resolveForWs = (dir: string) => this.resolveAdapter(dir, (slug) => this.tasks.mdFeatureIndex(ws.id, slug));
    const poller = new TrackerPoller(
      this.tasks,
      ws.id,
      ws.workingDir,
      ws.trackerPollIntervalSeconds * 1000,
      resolveForWs,
      this.onError,
      mirror,
      (resolved) => this.resolved.set(ws.id, resolved),
      epics,
      { reconcileOnPoll: this.scheduler === undefined },
    );
    const unregister = this.scheduler
      ? this.scheduler.register({
          name: 'Tracker poll',
          workspaceId: ws.id,
          intervalMs: ws.trackerPollIntervalSeconds * 1000,
          run: async () => {
            await poller.poll();
            await this.scheduler!.runNow('Epic reconcile');
          },
          enabled: () => this.resolved.get(ws.id)?.ok === true,
        })
      : (poller.start(), () => poller.stop());
    this.entries.set(ws.id, { poller, mirror, epics, ...(epicIntegrate ? { epicIntegrate } : {}), sig: sigOf(ws), unregister });
  }

  /** Integrate whatever subset is folded into the Epic's integration branch, bypassing the all-members gate but not Verification. `null` when the Workspace has no integrate coordinator. */
  async forceIntegrateEpic(workspaceId: number, epicRef: number): Promise<EpicIntegrateOutcome | null> {
    const entry = this.entries.get(workspaceId);
    if (!entry?.epicIntegrate) return null;
    return entry.epicIntegrate.submit(
      { ref: epicRef, members: [], memberRefs: entry.epics.membersOf(epicRef) },
      { force: true },
    );
  }

  /** Whether a mirrored Task's integration-branch base is unresolved or points at an `epic/<ref>` branch git doesn't have; no live loop ⇒ false. */
  async epicBaseNotReady(task: TaskRow): Promise<boolean> {
    return (await this.entryFor(task.workspaceId)?.epics.memberBaseNotReady(task)) ?? false;
  }

  /** Notify the one Workspace whose default branch just advanced. */
  async refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void> {
    const entry = [...this.entries.values()].find((candidate) => candidate.sig.startsWith(`${workingDir}|`));
    if (entry) await entry.epics.refreshAfterDefaultBranchAdvance(defaultBranch);
  }

  private liveEpicsByRef(tickets: Ticket[], mirrored: TaskWithDeps[]): Map<number, DerivedEpic> {
    return new Map(
      deriveLeafEpics(tickets, this.readinessByRef(mirrored), { includeClosed: true })
        .map((epic) => [epic.ref, epic] as const),
    );
  }

  /** Every Epic this Workspace surfaces, enumerated from the stored `epics` rows. */
  async listEpics(workspaceId: number): Promise<Epic[]> {
    const entry = this.entries.get(workspaceId);
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const rows = await this.tasks.listStoredEpics(workspaceId);
    const rowByRef = new Map(rows.map((r) => [r.trackerRef, r] as const));
    const derived = this.surfacedEpics(rows, tickets, mirrored, { includeHistorical: false });
    const baseBranch = await this.epicBaseBranch(workspaceId);
    const configured = await this.verificationConfigured(workspaceId);
    return Promise.all(derived.map((one) => this.composeOne(entry, one, tickets, mirrored, baseBranch, rowByRef, configured)));
  }

  /** The ticket for each surfaced Epic: the live container ticket, or a snapshot-backed placeholder for a historical Epic. */
  async listEpicTickets(workspaceId: number): Promise<Ticket[]> {
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const byRef = new Map(tickets.map((ticket) => [ticket.number, ticket]));
    const rows = await this.tasks.listStoredEpics(workspaceId);
    return this.surfacedEpics(rows, tickets, mirrored, { includeHistorical: true }).map(
      (epic) => byRef.get(epic.ref) ?? historicalEpicTicket(epic),
    );
  }

  private surfacedEpics(
    rows: EpicRow[],
    tickets: Ticket[],
    mirrored: TaskWithDeps[],
    opts: { includeHistorical: boolean },
  ): DerivedEpic[] {
    const liveByRef = this.liveEpicsByRef(tickets, mirrored);
    const ticketByRef = new Map(tickets.map((t) => [t.number, t]));
    const out: DerivedEpic[] = [];
    for (const row of rows) {
      if (this.isHistoricalEpic(row)) {
        if (opts.includeHistorical) out.push(this.storedEpicToDerived(row, tickets, mirrored));
        continue;
      }
      if (ticketByRef.get(row.trackerRef)?.state !== 'open') continue;
      const derived = liveByRef.get(row.trackerRef);
      if (derived) out.push(derived);
    }
    return out.sort((a, b) => a.ref - b.ref);
  }

  /** One Epic by ref, resolved from its stored row; null when none. */
  async epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null> {
    const entry = this.entries.get(workspaceId);
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const rows = await this.tasks.listStoredEpics(workspaceId);
    const row = rows.find((r) => r.trackerRef === epicRef);
    if (!row) return null;
    const rowByRef = new Map(rows.map((r) => [r.trackerRef, r] as const));
    const derived = this.isHistoricalEpic(row)
      ? this.storedEpicToDerived(row, tickets, mirrored)
      : this.liveEpicsByRef(tickets, mirrored).get(epicRef);
    if (!derived) return null;
    const configured = await this.verificationConfigured(workspaceId);
    return this.composeOne(entry, derived, tickets, mirrored, await this.epicBaseBranch(workspaceId), rowByRef, configured);
  }

  private isHistoricalEpic(row: EpicRow): boolean {
    return row.state === 'integrated' && row.memberRefs != null;
  }

  private storedEpicToDerived(row: EpicRow, tickets: Ticket[], mirrored: TaskRow[]): DerivedEpic {
    const title =
      tickets.find((t) => t.number === row.trackerRef)?.title ??
      mirrored.find((t) => t.trackerRef === row.trackerRef)?.trackerTitle ??
      `Epic #${row.trackerRef}`;
    return {
      ref: row.trackerRef,
      title,
      members: [...(row.memberRefs ?? [])].sort((a, b) => a - b),
      ready: [],
    };
  }

  private readinessByRef(mirrored: TaskWithDeps[]): Map<number, { agentWorkable: boolean }> {
    const readinessByRef = new Map<number, { agentWorkable: boolean }>();
    for (const task of mirrored) {
      if (task.trackerRef !== null) readinessByRef.set(task.trackerRef, { agentWorkable: task.agentWorkable });
    }
    return readinessByRef;
  }

  private async composeOne(
    entry: Entry | undefined,
    derived: DerivedEpic,
    tickets: Ticket[],
    mirrored: TaskRow[],
    baseBranch: string | null,
    rowByRef: ReadonlyMap<number, EpicRow>,
    configured: boolean,
  ): Promise<Epic> {
    const titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    const taskByRef = new Map<number, TaskRow>();
    for (const task of mirrored) {
      if (task.trackerRef != null) taskByRef.set(task.trackerRef, task);
    }
    const facts = await this.epicFacts(entry, derived.ref, configured);
    const ticket = tickets.find((t) => t.number === derived.ref);
    const meta: EpicMeta = {
      description: ticket?.body ?? '',
      createdAt: ticket ? Date.parse(ticket.createdAt) || 0 : 0,
      baseBranch,
      dependsOn: (ticket?.blockedBy ?? []).map((b) => b.number).sort((a, b) => a - b),
      kind: rowByRef.get(derived.ref)?.kind === 'map' ? 'map' : 'spec',
      state: rowByRef.get(derived.ref)?.state === 'integrated' ? 'integrated' : 'open',
    };
    return composeEpicView(derived, taskByRef, titleByRef, facts, meta);
  }

  private async epicBaseBranch(workspaceId: number): Promise<string | null> {
    const workingDir = (await this.getWorkspaces()).find((w) => w.id === workspaceId)?.workingDir;
    if (workingDir == null) return null;
    return resolveRepositoryDefaultBranch(workingDir).catch(() => null);
  }

  /** The whole-Epic diff: the live `base...epic/<ref>` range while open, the stored merge commit's diff once integrated. Empty string on no branch or any git failure. */
  async epicDiff(workspaceId: number, epicRef: number): Promise<string> {
    const workingDir = (await this.getWorkspaces()).find((w) => w.id === workspaceId)?.workingDir;
    if (workingDir == null) return '';
    const row = (await this.tasks.listStoredEpics(workspaceId)).find((r) => r.trackerRef === epicRef);
    try {
      if (row?.state === 'integrated') {
        return row.mergeCommit ? await Git.diffMergeCommit(workingDir, row.mergeCommit) : '';
      }
      const base = await resolveRepositoryDefaultBranch(workingDir).catch(() => null);
      if (base == null) return '';
      return await Git.diffUnified(workingDir, base, integrationBranchName(epicRef));
    } catch {
      return '';
    }
  }

  private async epicFacts(entry: Entry | undefined, epicRef: number, configured: boolean): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef);
    const epicIntegrate = entry?.epicIntegrate;
    const integration = epicIntegrate ? await epicIntegrate.integrationFacts(epicRef) : { exists: false, tip: null };
    return {
      integration: { branch, ...integration },
      verification: { status: epicIntegrate?.verificationStatus(epicRef) ?? null, configured },
      integrate: {
        inFlight: epicIntegrate?.isInFlight(epicRef) ?? false,
        held: epicIntegrate?.heldReason(epicRef) ?? null,
      },
    };
  }

  private async verificationConfigured(workspaceId: number): Promise<boolean> {
    const getConfig = this.getConfig;
    if (!getConfig) return false;
    const ws = (await this.getWorkspaces()).find((w) => w.id === workspaceId);
    if (!ws) return false;
    return resolveVerifiers(ws, getConfig()).commands.length > 0;
  }

  /** The last-resolved tracker for a Workspace, or null when tracking is off / not yet resolved. */
  resolvedTracker(workspaceId: number): ResolvedTracker | null {
    return this.resolved.get(workspaceId) ?? null;
  }

  private entryFor(workspaceId: number | null): Entry | undefined {
    return workspaceId === null ? undefined : this.entries.get(workspaceId);
  }

  /** The advisory-assignment coordinator for a Workspace, when it has a running poll loop. */
  coordinatorFor(workspaceId: number | null): MirrorCoordinator | undefined {
    return this.entryFor(workspaceId)?.mirror;
  }

  /** Map rollups, each stamped with its Workspace; scoped to one Workspace when given, else all. */
  async maps(workspaceId?: number): Promise<DerivedMap[]> {
    const rows = await this.tasks.list(workspaceId === undefined ? {} : { workspaceId });
    const containers = await this.tasks.listTrackerContainers(workspaceId);
    const byWorkspace = new Map<number, TaskRow[]>();
    await forEachYielding(rows, (task) => {
      if (task.origin !== 'mirrored' || task.workspaceId === null) return;
      const workspaceRows = byWorkspace.get(task.workspaceId);
      if (workspaceRows) workspaceRows.push(task);
      else byWorkspace.set(task.workspaceId, [task]);
    });
    await forEachYielding(containers, (container) => {
      if (!byWorkspace.has(container.workspaceId)) byWorkspace.set(container.workspaceId, []);
    });
    const containersByWorkspace = new Map<number, typeof containers>();
    await forEachYielding(containers, (container) => {
      const workspaceContainers = containersByWorkspace.get(container.workspaceId);
      if (workspaceContainers) workspaceContainers.push(container);
      else containersByWorkspace.set(container.workspaceId, [container]);
    });
    const maps: DerivedMap[] = [];
    await forEachYielding(byWorkspace, async ([id, mirrored]) => {
      const tickets = await persistedTickets(mirrored, containersByWorkspace.get(id) ?? []);
      maps.push(...deriveMaps(tickets, mirrored, id));
    });
    return maps;
  }

  /** The tracker URL for a mirrored Task's ref, scoped to its Workspace's last scan; null otherwise. */
  urlFor(workspaceId: number | null, ref: number | null): string | null {
    return this.entryFor(workspaceId)?.poller.urlFor(ref) ?? null;
  }

  /** A mapRef's title, scoped to its Workspace's last scan; null otherwise. */
  titleForMap(workspaceId: number | null, ref: number | null): string | null {
    return this.entryFor(workspaceId)?.poller.titleForMap(ref) ?? null;
  }

  /** Force an immediate poll: re-resolves the tracker first; a running loop rescans now and rejects if the scan fails. */
  async pollNow(workspaceId: number): Promise<void> {
    const ws = (await this.getWorkspaces()).find((w) => w.id === workspaceId);
    if (!ws || !ws.trackerEnabled) return;
    const resolved = await resolveTracker(ws.workingDir, this.resolveAdapter);
    this.resolved.set(ws.id, resolved);
    const entry = this.entries.get(ws.id);
    if (!resolved.ok) {
      if (!this.scheduler) {
        entry?.poller.stop();
        entry?.unregister();
        this.entries.delete(ws.id);
      }
      return;
    }
    if (entry) {
      await entry.poller.poll();
    } else {
      this.startLoop(ws);
    }
  }

  /** Stop every poll loop (server shutdown). */
  stopAll(): void {
    for (const entry of this.entries.values()) {
      entry.poller.stop();
      entry.unregister();
    }
    this.entries.clear();
  }

  /** Reconcile every live Workspace's Epic integration state as one global Job. */
  async reconcileEpics(): Promise<void> {
    await forEachYielding(this.entries, async ([id, entry]) => {
      if (this.resolved.get(id)?.ok) await entry.poller.reconcileEpics();
    });
  }
}
