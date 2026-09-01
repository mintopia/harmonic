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

/** Integrate an Epic's `epic/<ref>` branch into the default branch under the one
 * merge policy (ADR-0001) — wired to `Runner.mergeEpicIntegration`. The caller
 * supplies `runPostMergeCheck`, which re-runs the Workspace's whole-Epic verifiers
 * on the merged tip. */
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
  /** This Workspace's per-Epic integration-branch coordinator (issue #159) — the pick gate routes to it. */
  epics: EpicIntegrationCoordinator;
  /** This Workspace's whole-Epic integrate coordinator (issue #161) — the operator
   * force-integrate action routes to it. Absent when no config resolver was supplied. */
  epicIntegrate?: EpicIntegrateCoordinator;
  /** `${workingDir}|${intervalMs}` — a change here means tear down and rebuild. */
  sig: string;
  unregister: () => void;
}

const sigOf = (ws: WorkspaceRow): string => `${ws.workingDir}|${ws.trackerPollIntervalSeconds * 1000}`;

/** A placeholder ticket for a historical Epic the tracker scan has aged out, so
 * the Tasks-list projection can render it from the stored record's snapshot when
 * no live container ticket survives. Only its identity (ref, title) carries real
 * data; the list row (`epicToListRow`) reads nothing else off it, `isMap` included. */
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
    /**
     * The effective app config, read per poll to resolve a Workspace's
     * Verification verifiers for the whole-Epic integrate (issue #161). Absent ⇒ no
     * automatic whole-Epic integrate is wired (the integration-branch base-set half,
     * #159, still runs) — used by tests that don't exercise the integrate path.
     */
    private readonly getConfig?: () => Pick<AppConfig, 'verify'>,
    private readonly epicOperations: EpicOperations = new EpicOperations(),
    /** The central recurring-work owner (issue #305). Omitted only by focused legacy unit tests. */
    private readonly scheduler?: Scheduler,
    /** Cooperative-yield injection for the sync sweep over a large Workspace
     * set (issue #200); default yields on the standard wall-clock budget. */
    private readonly opts: { yieldOptions?: YieldOptions } = {},
    /** Integrate a whole Epic into the default branch under the one merge policy
     * (ADR-0001) — wired to `Runner.mergeEpicIntegration`. Absent ⇒ no automatic
     * whole-Epic integrate is wired (used by tests that don't exercise it). */
    private readonly mergeEpicIntegration?: MergeEpicIntegration,
    private readonly dispatchEpicRefreshResolution: (
      target: EpicRefreshTarget,
      detail: string,
      escalate: (epicRef: number, reason: string) => void,
      /** Re-runs the refresh once the corrective turn's worktree is gone — a
       * resolved merge completes it, an unresolved one escalates (issue #315). */
      retry: () => Promise<unknown>,
    ) => Promise<EpicRefreshResolveDispatchOutcome> = async () => ({ status: 'dispatched' }),
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
    // The whole-Epic integrate (issue #161): once every member has merged onto the
    // integration branch, Verify the integrated whole and, on a pass, integrate it
    // atomically into the default branch and retire it. Wired only when a config
    // resolver is present (it resolves this Workspace's Verification verifiers).
    // Built after `epics` so its `retire` closes over that instance's retire
    // method, then attached back into the reconcile as the integrate trigger.
    let epicIntegrate: EpicIntegrateCoordinator | undefined;
    const getConfig = this.getConfig;
    const mergeEpicIntegration = this.mergeEpicIntegration;
    if (getConfig && mergeEpicIntegration) {
      // Resolve verifiers against the *live* Workspace row (its verifier override
      // columns can change without rebuilding the loop — sig tracks only
      // dir/interval) and the current global config.
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
            // The ADR-0001 post-merge check on the merged default-branch tip: the
            // same whole-Epic verifiers, re-run once on what the base became.
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
        // Settle the stored Epic record at integration (ADR-0018, #438): merge-commit
        // hash (null on a no-op finish), member snapshot, lifecycle → integrated —
        // then close the Epic's tracker issue (#442), which a container's empty agent
        // path never would.
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
    this.entries.set(ws.id, { poller, mirror, epics, ...(epicIntegrate ? { epicIntegrate } : {}), sig: sigOf(ws), unregister });
  }

  /**
   * Operator force-integrate-the-ready-subset for an Epic (issue #161): integrate whatever
   * subset is currently folded into the Epic's integration branch, even though a
   * sibling member is stuck — bypassing the all-members-`completed` gate but
   * **not** Verification (a failing whole-Epic Verification still escalates). The
   * explicit, never-automatic partial-integrate action the acceptance criteria pin.
   * Returns `null` when the Workspace has no running loop / no integrate coordinator
   * (tracking off), so the caller can surface a 404/409.
   */
  async forceIntegrateEpic(workspaceId: number, epicRef: number): Promise<EpicIntegrateOutcome | null> {
    const entry = this.entries.get(workspaceId);
    if (!entry?.epicIntegrate) return null;
    // Snapshot the Epic's member refs for the record even on the force path (#438),
    // where `members` is elided because force bypasses the per-member gate.
    return entry.epicIntegrate.submit(
      { ref: epicRef, members: [], memberRefs: entry.epics.membersOf(epicRef) },
      { force: true },
    );
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

  /** Notify the one Workspace whose default branch just advanced. */
  async refreshAfterDefaultBranchAdvance(workingDir: string, defaultBranch: string): Promise<void> {
    const entry = [...this.entries.values()].find((candidate) => candidate.sig.startsWith(`${workingDir}|`));
    if (entry) await entry.epics.refreshAfterDefaultBranchAdvance(defaultBranch);
  }

  /** Live members+ready for every leaf-most container in the scan, keyed by ref;
   *  includeClosed so a closed-but-still-scanned Epic still resolves. */
  private liveEpicsByRef(tickets: Ticket[], mirrored: TaskWithDeps[]): Map<number, DerivedEpic> {
    return new Map(
      deriveLeafEpics(tickets, this.readinessByRef(mirrored), { includeClosed: true })
        .map((epic) => [epic.ref, epic] as const),
    );
  }

  /** Every Epic this Workspace surfaces: the stored `epics` record is the
   * single enumeration source (ADR-0018) — an open row's live membership and
   * ready frontier are derived at read time, and an integrated row surfaces
   * from its frozen member snapshot once its container ages out of the scan. */
  async listEpics(workspaceId: number): Promise<Epic[]> {
    const entry = this.entries.get(workspaceId);
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const rows = await this.tasks.listStoredEpics(workspaceId);
    const kindByRef = new Map(rows.map((r) => [r.trackerRef, r.kind === 'map' ? 'map' : 'spec'] as const));
    const derived = this.surfacedEpics(rows, tickets, mirrored);
    const baseBranch = await this.epicBaseBranch(workspaceId);
    return Promise.all(derived.map((one) => this.composeOne(entry, one, tickets, mirrored, baseBranch, kindByRef)));
  }

  /** The ticket for each surfaced Epic, so the Tasks list sources epic rows from
   * the same set the Board reads (ADR-0016, #439): the live container ticket for
   * an open Epic, and a snapshot-backed placeholder ticket for a historical Epic
   * the scan has aged out. */
  async listEpicTickets(workspaceId: number): Promise<Ticket[]> {
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const byRef = new Map(tickets.map((ticket) => [ticket.number, ticket]));
    const rows = await this.tasks.listStoredEpics(workspaceId);
    return this.surfacedEpics(rows, tickets, mirrored).map(
      (epic) => byRef.get(epic.ref) ?? historicalEpicTicket(epic),
    );
  }

  /** The surfaced Epic set (ascending by ref): the stored `epics` record is the
   * single enumeration source (ADR-0018) — an integrated row surfaces from its
   * frozen snapshot; an open row surfaces only while its container is still in
   * the scan and open (Board stays open-only), with membership + ready frontier
   * derived live at read time. A row whose container became a spine, or lost
   * its members, or hasn't aged into its stored snapshot yet, is skipped rather
   * than surfaced empty. */
  private surfacedEpics(rows: EpicRow[], tickets: Ticket[], mirrored: TaskWithDeps[]): DerivedEpic[] {
    const liveByRef = this.liveEpicsByRef(tickets, mirrored);
    const ticketByRef = new Map(tickets.map((t) => [t.number, t]));
    const out: DerivedEpic[] = [];
    for (const row of rows) {
      if (this.isHistoricalEpic(row)) {
        // Integrated: the frozen snapshot is authority regardless of scan state.
        out.push(this.storedEpicToDerived(row, tickets, mirrored));
        continue;
      }
      if (ticketByRef.get(row.trackerRef)?.state !== 'open') continue; // Board stays open-only
      const derived = liveByRef.get(row.trackerRef);
      if (derived) out.push(derived); // absent ⇒ became spine / lost members → skip
    }
    return out.sort((a, b) => a.ref - b.ref);
  }

  /** One Epic by ref from this Workspace's persisted tracker facts, resolved
   * solely from its stored row (ADR-0018): an integrated row from its frozen
   * snapshot, else its live membership + ready frontier at read time (a closed
   * but still-scanned container still resolves via `includeClosed`). */
  async epicDetail(workspaceId: number, epicRef: number): Promise<Epic | null> {
    const entry = this.entries.get(workspaceId);
    const mirrored = (await this.tasks.listWithDeps({ workspaceId })).filter((task) => task.origin === 'mirrored');
    const tickets = await persistedTickets(mirrored, await this.tasks.listTrackerContainers(workspaceId));
    const rows = await this.tasks.listStoredEpics(workspaceId);
    const row = rows.find((r) => r.trackerRef === epicRef);
    if (!row) return null;
    const kindByRef = new Map(rows.map((r) => [r.trackerRef, r.kind === 'map' ? 'map' : 'spec'] as const));
    const derived = this.isHistoricalEpic(row)
      ? this.storedEpicToDerived(row, tickets, mirrored)
      : this.liveEpicsByRef(tickets, mirrored).get(epicRef);
    if (!derived) return null;
    return this.composeOne(entry, derived, tickets, mirrored, await this.epicBaseBranch(workspaceId), kindByRef);
  }

  /** A stored Epic surfaces from its record only once integrated with a member
   * snapshot: an `open` row is still governed by live derivation, and an
   * integrated row with a null snapshot carries no members to list. */
  private isHistoricalEpic(row: EpicRow): boolean {
    return row.state === 'integrated' && row.memberRefs != null;
  }

  /** A historical stored Epic as a {@link DerivedEpic} composed from its
   * integration snapshot: members frozen at integration (ascending), an empty
   * ready frontier (nothing left to drive). Its title comes from a surviving
   * ticket/mirrored Task, else a ref placeholder when the scan has aged it out. */
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
    baseBranch: string | null,
    kindByRef: ReadonlyMap<number, 'map' | 'spec'>,
  ): Promise<Epic> {
    const titleByRef = new Map(tickets.map((t) => [t.number, t.title]));
    const taskByRef = new Map<number, TaskRow>();
    for (const task of mirrored) {
      if (task.trackerRef != null) taskByRef.set(task.trackerRef, task);
    }
    const facts = await this.epicFacts(entry, derived.ref);
    const ticket = tickets.find((t) => t.number === derived.ref);
    const meta: EpicMeta = {
      description: ticket?.body ?? '',
      createdAt: ticket ? Date.parse(ticket.createdAt) || 0 : 0,
      baseBranch,
      dependsOn: (ticket?.blockedBy ?? []).map((b) => b.number).sort((a, b) => a - b),
      kind: kindByRef.get(derived.ref) ?? 'spec',
    };
    return composeEpicView(derived, taskByRef, titleByRef, facts, meta);
  }

  /** The repo default branch the whole-Epic gate merges `epic/<ref>` into
   * (ADR-0017 Properties) — git-derived, best-effort, `null` if unresolved. */
  private async epicBaseBranch(workspaceId: number): Promise<string | null> {
    const workingDir = (await this.getWorkspaces()).find((w) => w.id === workspaceId)?.workingDir;
    if (workingDir == null) return null;
    return resolveRepositoryDefaultBranch(workingDir).catch(() => null);
  }

  /** The whole-Epic diff (ADR-0018): what `epic/<ref>` changes over base. While
   * open, the live `base...epic/<ref>` range; once integrated, the frozen
   * `git diff <M>^1 <M>^2` from the stored merge commit, which survives the
   * branch's retirement. A branchless/no-op Epic (and any git failure) yields the
   * empty string — the caller renders an empty state, never an error. */
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

  /**
   * The server-only facts {@link composeOne} folds into the `Epic` DTO (issue
   * #167 sourcing notes):
   *  - `integration`: the branch's existence/tip via the Workspace's
   *    {@link EpicIntegrateCoordinator} (it already holds the `EpicIntegrateGit` slice
   *    the integrate attempt itself uses) — `exists:false, tip:null` when no integrate
   *    coordinator is active for this Workspace (tracking config resolver
   *    absent), same as an Epic whose branch was never cut.
   *  - `integrate`: `inFlight`/`held` straight off the coordinator's own guards.
   *  - `verification`: the whole-Epic Verification status retained on the
   *    {@link EpicIntegrateCoordinator} (issue #178) — `pending` while a verify is in
   *    flight, `pass`/`fail` for the last verdict, `null` when none has run for
   *    the current integration branch (or no integrate coordinator is active).
   */
  private async epicFacts(entry: Entry | undefined, epicRef: number): Promise<EpicFacts> {
    const branch = integrationBranchName(epicRef);
    const epicIntegrate = entry?.epicIntegrate;
    const integration = epicIntegrate ? await epicIntegrate.integrationFacts(epicRef) : { exists: false, tip: null };
    return {
      integration: { branch, ...integration },
      verification: { status: epicIntegrate?.verificationStatus(epicRef) ?? null },
      integrate: {
        inFlight: epicIntegrate?.isInFlight(epicRef) ?? false,
        held: epicIntegrate?.heldReason(epicRef) ?? null,
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
