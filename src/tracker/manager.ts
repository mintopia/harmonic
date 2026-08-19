import type { TaskRow, WorkspaceRow } from '../db/schema.js';
import type { AppConfig } from '../config.js';
import type { TaskService } from '../domain/tasks.js';
import { resolveVerifiers } from '../domain/setting-override.js';
import type { ResolvedTracker, TrackerAdapter } from './adapter.js';
import { resolveTracker, resolveTrackerAdapter } from './adapter.js';
import { MirrorCoordinator } from './coordinator.js';
import { TrackerPoller } from './poller.js';
import type { DerivedMap } from './mirror.js';
import { EpicIntegrationCoordinator, integrationBranchName } from '../execution/epic-integration.js';
import { EpicLandCoordinator, type EpicLandOutcome } from '../execution/epic-land-coordinator.js';
import { verifyEpicIntegration } from '../execution/epic-verification.js';
import { deriveEpics, type DerivedEpic } from '../domain/epic-derivation.js';
import { composeEpicView, type Epic, type EpicFacts } from '../domain/epic-view.js';

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
    private readonly getWorkspaces: () => WorkspaceRow[],
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly onMirrored: () => void = () => {},
    private readonly onError: (msg: string) => void = (msg) => console.error(msg),
    /** A mirrored Task whose ticket closed while it was still running (board-refresh backstop) — routed to the Runner to stop the parked agent and settle it done. */
    private readonly onClosedWhileRunning: (taskId: number) => void = () => {},
    /**
     * The effective app config, read per poll to resolve a Workspace's
     * Verification verifiers for the whole-Epic land (issue #161). Absent ⇒ no
     * automatic whole-Epic land is wired (the integration-branch base-set half,
     * #159, still runs) — used by tests that don't exercise the land path.
     */
    private readonly getConfig?: () => Pick<AppConfig, 'verification'>,
  ) {}

  /**
   * Reconcile running pollers to the current set of tracker-enabled Workspaces.
   * Idempotent. Async because starting a loop is now gated on resolving the
   * Workspace's tracker (issue #83): an enabled-but-unresolvable Workspace
   * caches its failure reason and never starts a loop, rather than erroring
   * every cycle. A Workspace that already has a running loop isn't re-resolved
   * here — its own poll cycles keep the cached Resolved Tracker fresh (the
   * poller's `onResolved`), and a manual {@link pollNow} forces it immediately.
   */
  async sync(): Promise<void> {
    const wsById = new Map(this.getWorkspaces().map((w) => [w.id, w]));
    // Stop pollers whose Workspace is gone, disabled tracking, or changed its repo/interval.
    for (const [id, entry] of this.entries) {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled || entry.sig !== sigOf(ws)) {
        entry.poller.stop();
        this.entries.delete(id);
      }
    }
    // Drop cached resolutions for Workspaces gone or with tracking off — no poll, no Resolved Tracker.
    for (const id of [...this.resolved.keys()]) {
      const ws = wsById.get(id);
      if (!ws || !ws.trackerEnabled) this.resolved.delete(id);
    }
    // For every tracker-enabled Workspace lacking a running loop: resolve its
    // tracker, cache the result, and start a loop only when it resolves. An
    // unresolvable one surfaces its reason but stays loop-less (issue #83).
    for (const ws of wsById.values()) {
      if (!ws.trackerEnabled || this.entries.has(ws.id)) continue;
      const resolved = await resolveTracker(ws.workingDir, this.resolveAdapter);
      this.resolved.set(ws.id, resolved);
      if (resolved.ok) this.startLoop(ws);
    }
  }

  /** Build and start a poll loop for a Workspace (its tracker already resolved). */
  private startLoop(ws: WorkspaceRow): void {
    const mirror = new MirrorCoordinator(this.tasks, ws.id);
    // Harmonic-owned per-Epic integration branches for this Workspace (issue
    // #159): cut in its Working Directory, one per derived Epic with a ready
    // member, and each ready member's base branch pointed at it before the poke.
    const epics = new EpicIntegrationCoordinator(this.tasks, ws.workingDir);
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
        verify: ({ repoDir, candidateOid }) => {
          // Resolve verifiers against the *live* Workspace row (its verifier
          // override columns can change without rebuilding the loop — sig tracks
          // only dir/interval) and the current global config.
          const live = this.getWorkspaces().find((w) => w.id === ws.id) ?? ws;
          return verifyEpicIntegration({ repoDir, candidateOid, verifiers: resolveVerifiers(live, getConfig()) });
        },
        retire: (epicRef) => epics.retireIntegrationBranch(epicRef),
        escalate: (epicRef, reason) => this.onError(`epic ${epicRef} whole-Epic land escalated: ${reason}`),
      });
      epics.attachLandTrigger(epicLand);
    }
    const poller = new TrackerPoller(
      this.tasks,
      ws.id,
      ws.workingDir,
      ws.trackerPollIntervalSeconds * 1000,
      this.resolveAdapter,
      this.onMirrored,
      this.onError,
      mirror,
      (resolved) => this.resolved.set(ws.id, resolved), // keep the Resolved Tracker fresh every poll (issue #83)
      this.onClosedWhileRunning,
      epics,
    );
    this.entries.set(ws.id, { poller, mirror, epics, ...(epicLand ? { epicLand } : {}), sig: sigOf(ws) });
    poller.start();
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
   * Whether a mirrored Task is a ready Epic member still awaiting its
   * integration-branch base (issue #159) — the Auto-Runner's pick gate. Routed
   * to the Task's own Workspace coordinator; no live loop ⇒ not gated (false),
   * so a Workspace without tracking keeps today's per-Run behaviour.
   */
  awaitsEpicBase(task: TaskRow): boolean {
    return this.entryFor(task.workspaceId)?.epics.awaitsBase(task) ?? false;
  }

  /**
   * Every derived Epic for a Workspace's last poll scan (issue #167, ADR-0026)
   * — the operator read endpoint's list surface. Empty when the Workspace has
   * no running poll loop (tracking off) or its last scan derived none, not an
   * error: the caller 200s `{ epics: [] }` either way.
   */
  async listEpics(workspaceId: number): Promise<Epic[]> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return [];
    const derivedEpics = deriveEpics(entry.poller.tickets());
    return Promise.all(derivedEpics.map((derived) => this.composeOne(workspaceId, entry, derived)));
  }

  /**
   * One derived Epic by ref for a Workspace's last poll scan (issue #167,
   * ADR-0026) — the operator read endpoint's detail surface. `null` when the
   * Workspace has no running loop or its last scan doesn't derive `epicRef` as
   * a leaf-most Epic; the route maps that to a 404.
   */
  async epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return null;
    const derived = deriveEpics(entry.poller.tickets()).find((e) => e.ref === epicRef);
    if (!derived) return null;
    return this.composeOne(workspaceId, entry, derived);
  }

  /** Shared plumbing for {@link listEpics}/{@link epicDetail}: match member
   * refs to this Workspace's mirrored Task rows and titles from the same scan,
   * gather the git/coordinator facts, and fold everything through the pure
   * {@link composeEpicView}. */
  private async composeOne(workspaceId: number, entry: Entry, derived: DerivedEpic): Promise<Epic> {
    const tickets = entry.poller.tickets();
    const titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    const taskByRef = new Map<number, TaskRow>();
    for (const task of this.tasks.list({ workspaceId })) {
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
   *  - `verification`: always `null` — the whole-Epic Verification result is
   *    computed and used inline inside `EpicLandCoordinator.attempt` and never
   *    retained anywhere this accessor can reach; the sourcing notes forbid
   *    inventing a new store for it, so this is a `// ponytail:` gap, not an
   *    oversight, until a dedicated cache exists.
   */
  private async epicFacts(entry: Entry, epicRef: number): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef);
    const epicLand = entry.epicLand;
    const integration = epicLand ? await epicLand.integrationFacts(epicRef) : { exists: false, tip: null };
    return {
      integration: { branch, ...integration },
      // ponytail: no reachable store for the whole-Epic Verification result
      // (see the doc comment above) — always null until one exists.
      verification: { status: null },
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
   * refresh. Re-resolves the tracker first and refreshes the cached Resolved
   * Tracker (issue #83), so a refresh both re-mirrors and re-checks resolution:
   * - tracking off / no such Workspace ⇒ no-op.
   * - now unresolvable ⇒ cache the reason and tear down any running loop.
   * - resolvable but loop-less (a prior failure, now fixed) ⇒ bring the loop up.
   * - already running ⇒ rescan now, rejecting if the scan fails (unlike the
   *   background loop, which swallows) so a manual refresh surfaces it.
   */
  async pollNow(workspaceId: number): Promise<void> {
    const ws = this.getWorkspaces().find((w) => w.id === workspaceId);
    if (!ws || !ws.trackerEnabled) return;
    const resolved = await resolveTracker(ws.workingDir, this.resolveAdapter);
    this.resolved.set(ws.id, resolved);
    const entry = this.entries.get(ws.id);
    if (!resolved.ok) {
      entry?.poller.stop();
      this.entries.delete(ws.id);
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
    for (const entry of this.entries.values()) entry.poller.stop();
    this.entries.clear();
  }
}
