import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import type { AppConfig } from '../config.js';
import type { TaskService, TaskWithDeps } from '../domain/tasks.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import type { ResolvedTracker, Ticket, TrackerAdapter } from './adapter.js';
import { resolveTracker, resolveTrackerAdapter } from './adapter.js';
import type { FeatureIndex } from './local-markdown.js';
import { MirrorCoordinator } from './coordinator.js';
import { TrackerPoller } from './poller.js';
import { deriveMaps, type DerivedMap } from './mirror.js';
import { EpicIntegrationCoordinator, integrationBranchName } from '../execution/epic-integration.js';
import { EpicLandCoordinator, type EpicLandOutcome } from '../execution/epic-land-coordinator.js';
import { verifyEpicIntegration } from '../execution/epic-verification.js';
import { EpicOperations } from '../execution/epic-operations.js';
import { deriveEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts } from '../domain/epic-view.js';
import { persistedTickets } from './persisted.js';
import { forEachYielding, type YieldOptions } from '../reliability/yield.js';
import { logger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';

interface Entry {
  poller: TrackerPoller;
  mirror: MirrorCoordinator;
  /** This Workspace's per-Epic integration-branch coordinator (issue #159) — the pick gate routes to it. */
  epics: EpicIntegrationCoordinator;
  /** This Workspace's whole-Epic land coordinator (issue #161) — the operator
   * force-land action routes to it. Absent when no config resolver was supplied. */
  epicLand?: EpicLandCoordinator;
  /** `${workingDir}|${intervalMs}` — a change here means tear down and rebuild. */
  sig: string;
  unregister: () => void;
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
  /**
   * The last-computed Resolved Tracker per tracker-enabled Workspace (issue
   * #83). Set whenever resolution runs — in {@link sync} before the poll-loop
   * gate and on a manual {@link pollNow} refresh — and dropped when a Workspace
   * disables tracking or is deleted. In-memory, like the poller's own scan
   * cache: derived from the repo, never persisted.
   */
  private resolved = new Map<number, ResolvedTracker>();

  constructor(
    private readonly tasks: TaskService,
    private readonly getWorkspaces: () => Promise<WorkspaceRow[]>,
    private readonly resolveAdapter: (
      repoRoot: string,
      featureIndex?: FeatureIndex,
    ) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onError: (msg: string) => void = logger.error,
    /** A mirrored Task whose ticket closed while it was still running (board-refresh backstop) — routed to the Runner to stop the parked agent and settle it done. */
    private readonly onClosedWhileRunning: (taskId: number) => void = () => {},
    /**
     * The effective app config, read per poll to resolve a Workspace's
     * Verification verifiers for the whole-Epic land (issue #161). Absent ⇒ no
     * automatic whole-Epic land is wired (the integration-branch base-set half,
     * #159, still runs) — used by tests that don't exercise the land path.
     */
    private readonly getConfig?: () => Pick<AppConfig, 'verification'>,
    private readonly epicOperations: EpicOperations = new EpicOperations(),
    /** The central recurring-work owner (issue #305). Omitted only by focused legacy unit tests. */
    private readonly scheduler?: Scheduler,
    /** Cooperative-yield injection for the sync sweep over a large Workspace
     * set (issue #200); default yields on the standard wall-clock budget. */
    private readonly opts: { yieldOptions?: YieldOptions } = {},
  ) {}

  /**
   * Reconcile Scheduler-owned tracker Jobs to the current tracker-enabled
   * Workspaces. An enabled-but-unresolvable Workspace keeps a disabled Job so
   * operators can see why it has no next run. A running Job isn't re-resolved
   * here — its own poll cycles keep the cached Resolved Tracker fresh, and a
   * manual {@link pollNow} forces it immediately.
   */
  async sync(): Promise<void> {
    const wsById = new Map((await this.getWorkspaces()).map((w) => [w.id, w]));
    // Stop pollers whose Workspace is gone, disabled tracking, or changed its repo/interval.
    await forEachYielding(this.entries, async ([id, entry]) => {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled || entry.sig !== sigOf(ws)) {
        entry.poller.stop();
        entry.unregister();
        this.entries.delete(id);
      }
    }, this.opts.yieldOptions);
    // Drop cached resolutions for Workspaces gone or with tracking off — no poll, no Resolved Tracker.
    await forEachYielding(this.resolved.keys(), async (id) => {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled) this.resolved.delete(id);
    }, this.opts.yieldOptions);
    // For every tracker-enabled Workspace lacking a Job: resolve its tracker,
    // cache the result, then register the Job even if disabled.
    await forEachYielding(wsById.values(), async (ws) => {
      if (!ws.trackerEnabled || this.entries.has(ws.id)) return;
      const resolved = await resolveTracker(ws.workingDir, this.resolveAdapter);
      this.resolved.set(ws.id, resolved);
      // Production keeps an unresolvable Workspace as a disabled Scheduler Job.
      // The no-Scheduler branch is retained for focused manager tests and the
      // pre-registry embedding, where a loop-less failure had no Job to expose.
      if (resolved.ok || this.scheduler) this.startLoop(ws);
    }, this.opts.yieldOptions);
  }

  /** Register one Scheduler-owned tracker poll Job for a Workspace. */
  private startLoop(ws: WorkspaceRow): void {
    const mirror = new MirrorCoordinator(this.tasks, ws.id);
    // Harmonic-owned per-Epic integration branches for this Workspace (issue
    // #159): cut in its Working Directory, one per derived Epic with a ready
    // member, and each ready member's base branch pointed at it before the next pick.
    const epics = new EpicIntegrationCoordinator(this.tasks, ws.workingDir);
    epics.attachOperations(this.epicOperations);
    // The whole-Epic land (issue #161): once every member has landed onto the
    // integration branch, Verify the integrated whole and, on a pass, land it
    // atomically into the default branch and retire it. Wired only when a config
    // resolver is present (it resolves this Workspace's Verification verifiers).
    // Built after `epics` so its `retire` closes over that instance's retire
    // method, then attached back into the reconcile as the land trigger.
    let epicLand: EpicLandCoordinator | undefined;
    const getConfig = this.getConfig;
    if (getConfig) {
      epicLand = new EpicLandCoordinator({
        repoDir: ws.workingDir,
        verify: async ({ repoDir, candidateOid }) => {
          // Resolve verifiers against the *live* Workspace row (its verifier
          // override columns can change without rebuilding the loop — sig tracks
          // only dir/interval) and the current global config.
          const live = (await this.getWorkspaces()).find((w) => w.id === ws.id) ?? ws;
          return verifyEpicIntegration({ repoDir, candidateOid, verifiers: resolveVerifiers(live, getConfig()) });
        },
        retire: (epicRef) => epics.retireIntegrationBranch(epicRef),
        escalate: (epicRef, reason) => this.onError(`epic ${epicRef} whole-Epic land escalated: ${reason}`),
        operations: this.epicOperations,
      });
      epics.attachLandTrigger(epicLand);
    }
    // Bind this Workspace's persistent feature-id index so local-markdown feature
    // bases stay small and stable across scans (see TaskService.mdFeatureIndex).
    const resolveForWs = (dir: string) => this.resolveAdapter(dir, (slug) => this.tasks.mdFeatureIndex(ws.id, slug));
    const poller = new TrackerPoller(
      this.tasks,
      ws.id,
      ws.workingDir,
      ws.trackerPollIntervalSeconds * 1000,
      resolveForWs,
      this.onError,
      mirror,
      (resolved) => this.resolved.set(ws.id, resolved), // keep the Resolved Tracker fresh every poll (issue #83)
      this.onClosedWhileRunning,
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
            // A fresh scan changes the persisted facts the global Job consumes;
            // request it through Scheduler rather than retaining a hidden
            // per-poll reconcile loop.
            await this.scheduler!.runNow('Epic reconcile');
          },
          // An unresolvable tracker remains visible to operators, but never invents
          // a next run or repeatedly emits failed scans. Manual refresh re-resolves
          // it and makes this same Job active again.
          enabled: () => this.resolved.get(ws.id)?.ok === true,
        })
      : (poller.start(), () => poller.stop());
    this.entries.set(ws.id, { poller, mirror, epics, ...(epicLand ? { epicLand } : {}), sig: sigOf(ws), unregister });
  }

  /**
   * Operator force-land-the-ready-subset for an Epic (issue #161): land whatever
   * subset is currently folded into the Epic's integration branch, even though a
   * sibling member is stuck — bypassing the all-members-`completed` gate but
   * **not** Verification (a failing whole-Epic Verification still escalates). The
   * explicit, never-automatic partial-land action the acceptance criteria pin.
   * Returns `null` when the Workspace has no running loop / no land coordinator
   * (tracking off), so the caller can surface a 404/409.
   */
  async forceLandEpic(workspaceId: number, epicRef: number): Promise<EpicLandOutcome | null> {
    const epicLand = this.entries.get(workspaceId)?.epicLand;
    if (!epicLand) return null;
    return epicLand.submit({ ref: epicRef, members: [] }, { force: true });
  }

  /**
   * Whether a mirrored Task is an Epic member not yet safe to spawn a worktree
   * Run for (issue #159): its integration-branch base is unresolved, or set to
   * an `epic/<ref>` branch that does not currently exist in git (#231). Consulted by
   * BOTH the Auto-Runner's pick gate and the Runner's start funnel, so neither
   * an auto-pick nor a hand-started Run forks off a missing integration branch.
   * Routed to the Task's own Workspace coordinator; no live loop ⇒ not gated
   * (false), so a Workspace without tracking keeps today's per-Run behaviour.
   */
  async epicBaseNotReady(task: TaskRow): Promise<boolean> {
    return (await this.entryFor(task.workspaceId)?.epics.memberBaseNotReady(task)) ?? false;
  }

  /** Every Epic derived from this Workspace's persisted tracker facts. */
  async listEpics(workspaceId: number): Promise<Epic[]> {
    const entry = this.entries.get(workspaceId);
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const derivedEpics = deriveEpics(tickets, this.readinessByRef(mirrored));
    return Promise.all(derivedEpics.map((derived) => this.composeOne(entry, derived, tickets, mirrored)));
  }

  /** One Epic derived by ref from this Workspace's persisted tracker facts. */
  async epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null> {
    const entry = this.entries.get(workspaceId);
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const derived = deriveEpics(tickets, this.readinessByRef(mirrored)).find((e) => e.ref === epicRef);
    if (!derived) return null;
    return this.composeOne(entry, derived, tickets, mirrored);
  }

  /** Frontier eligibility belongs to the mirrored Task, where Blocker edges are persisted. */
  private readinessByRef(mirrored: TaskWithDeps[]): Map<number, { agentWorkable: boolean }> {
    const readinessByRef = new Map<number, { agentWorkable: boolean }>();
    for (const task of mirrored) {
      if (task.trackerRef !== null) readinessByRef.set(task.trackerRef, { agentWorkable: task.agentWorkable });
    }
    return readinessByRef;
  }

  /** Shared plumbing for {@link listEpics}/{@link epicDetail}: match member
   * refs to mirrored Task rows and titles from the same persisted facts,
   * gather the git/coordinator facts, and fold everything through the pure
   * {@link composeEpicView}. */
  private async composeOne(
    entry: Entry | undefined,
    derived: DerivedEpic,
    tickets: Ticket[],
    mirrored: TaskRow[],
  ): Promise<Epic> {
    const titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    const taskByRef = new Map<number, TaskRow>();
    for (const task of mirrored) {
      if (task.trackerRef != null) taskByRef.set(task.trackerRef, task);
    }
    const facts = await this.epicFacts(entry, derived.ref);
    return composeEpicView(derived, taskByRef, titleByRef, facts);
  }

  /**
   * The server-only facts {@link composeOne} folds into the `Epic` DTO (issue
   * #167 sourcing notes):
   *  - `integration`: the branch's existence/tip via the Workspace's
   *    {@link EpicLandCoordinator} (it already holds the `EpicLandGit` slice
   *    the land attempt itself uses) — `exists:false, tip:null` when no land
   *    coordinator is active for this Workspace (tracking config resolver
   *    absent), same as an Epic whose branch was never cut.
   *  - `land`: `inFlight`/`held` straight off the coordinator's own guards.
   *  - `verification`: the whole-Epic Verification status retained on the
   *    {@link EpicLandCoordinator} (issue #178) — `pending` while a verify is in
   *    flight, `pass`/`fail` for the last verdict, `null` when none has run for
   *    the current integration branch (or no land coordinator is active).
   */
  private async epicFacts(entry: Entry | undefined, epicRef: number): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef);
    const epicLand = entry?.epicLand;
    const integration = epicLand ? await epicLand.integrationFacts(epicRef) : { exists: false, tip: null };
    return {
      integration: { branch, ...integration },
      verification: { status: epicLand?.verificationStatus(epicRef) ?? null },
      land: {
        inFlight: epicLand?.isInFlight(epicRef) ?? false,
        held: epicLand?.heldReason(epicRef) ?? null,
      },
    };
  }

  /** The last-resolved tracker for a Workspace, or null when tracking is off / not yet resolved (issue #83). */
  resolvedTracker(workspaceId: number): ResolvedTracker | null {
    return this.resolved.get(workspaceId) ?? null;
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

  /** A mapRef's title, scoped to its Workspace's last scan; null otherwise (issue #34). */
  titleForMap(workspaceId: number | null, ref: number | null): string | null {
    return this.entryFor(workspaceId)?.poller.titleForMap(ref) ?? null;
  }

  /**
   * Force an immediate poll for a Workspace's tracker — the board's manual
   * refresh. Re-resolves the tracker first and refreshes the cached Resolved
   * Tracker (issue #83), so a refresh both re-mirrors and re-checks resolution:
   * - tracking off / no such Workspace ⇒ no-op.
   * - now unresolvable ⇒ cache the reason and tear down any running loop.
   * - resolvable but loop-less (a prior failure, now fixed) ⇒ bring the loop up.
   * - already running ⇒ rescan now, rejecting if the scan fails (unlike the
   *   background loop, which swallows) so a manual refresh surfaces it.
   */
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
      this.startLoop(ws); // resolution just started passing — its own immediate poll mirrors now
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
