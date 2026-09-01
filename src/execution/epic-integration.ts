import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { deriveLeafEpics } from '../domain/epic-derivation.js';
import type { MemberMergeState } from '../domain/epic-integrate.js';
import type { Ticket } from '../tracker/adapter.js';
import { persistedTickets } from '../tracker/persisted.js';
import { Git } from './git.js';
import { logger } from '../logger.js';
import { EpicOperations } from './epic-operations.js';

/**
 * The integration branch Harmonic cuts for an Epic (ADR-0024): `epic/<ref>`,
 * keyed on the Epic ticket's tracker ref. Deterministic and derivable, so the
 * branch's own existence is the only state — no new grouping entity is stored
 * (ADR-0024), and re-entry recomputes the same name.
 */
export function integrationBranchName(epicRef: number): string {
  return `epic/${epicRef}`;
}

/**
 * The inverse of {@link integrationBranchName}: the Epic ref a branch name
 * encodes, or `null` when `name` is not an integration branch. The single
 * source of truth for "is this base branch an Epic integration branch?" — the
 * member-finish merge path (issue #163) uses it to tell an Epic member's Run
 * (whose base is `epic/<ref>`) from an ordinary worktree Run, so the detection
 * never drifts from the `epic/<ref>` format this module owns.
 */
export function parseIntegrationBranch(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /^epic\/(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface EpicGit {
  /** The branch HEAD points at, or `null` on a detached HEAD (never the literal `HEAD`). */
  symbolicBranch(dir: string): Promise<string | null>;
  branchExists(dir: string, name: string): Promise<boolean>;
  createBranch(dir: string, name: string, startPoint: string): Promise<unknown>;
  deleteBranch(dir: string, name: string): Promise<unknown>;
  branchCheckedOutAt(dir: string, branch: string): Promise<string | null>;
  isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean>;
}

/**
 * Task states that predate a worktree Run's spawn. Only these can be retargeted
 * at an integration branch: once a Run spawns, its base is resolved and frozen
 * (issue #157), so re-pointing the column would be a no-op at best and confuse a
 * re-attempt's carried-forward base at worst.
 */
const PRE_SPAWN: ReadonlySet<string> = new Set(['draft', 'ready']);

/**
 * The whole-Epic integrate trigger (issue #161) the reconcile fires per derived Epic
 * each poll. A structural interface, not the concrete {@link EpicIntegrateCoordinator}
 * import, so this module and the coordinator (which imports
 * {@link integrationBranchName} from here) don't form a cycle. `submit` is a
 * *level* trigger: harmless to call every poll — it no-ops until every member is
 * `completed`, and after a successful integrate the retired branch makes it a `noop`.
 */
export interface EpicIntegrateTrigger {
  submit(target: { ref: number; members: MemberMergeState[]; memberRefs?: number[] }, opts?: { force?: boolean }): Promise<unknown>;
}

/** Edge-triggered default-branch refresh hook. It is deliberately separate
 * from reconcile: polls discover Epics, but only a successful develop integrating
 * is allowed to request a refresh. */
export interface EpicRefreshTrigger {
  refresh(target: { ref: number; repoDir: string; defaultBranch: string }): Promise<unknown>;
}

/**
 * Reduce a member's mirrored Task to its merge state for the whole-Epic integrate
 * decision (issue #161): `completed` once it has merged onto the integration
 * branch (Task state `done`); `blocked` when it cannot merge (escalated to a
 * human, or `failed`/`cancelled`) and so holds the whole Epic back; `pending`
 * otherwise (still in progress, awaiting review, not yet started, or not mirrored).
 */
export function reduceMemberState(task: TaskRow | undefined): MemberMergeState {
  if (!task) return 'pending';
  if (task.state === 'done') return 'completed';
  if (task.state === 'escalated' || task.state === 'cancelled') return 'blocked';
  return 'pending';
}

/**
 * The per-Epic integration-branch lifecycle, owned by Harmonic (issue #159,
 * ADR-0023/0024). Once per poll, {@link reconcile} derives the leaf-most Epics
 * from the scan (issue #158) and, for each Epic with a ready frontier, ensures
 * its integration branch exists (cut once from the default branch, reused
 * idempotently thereafter) and *then* points each ready member's mirrored Task
 * at it via `baseBranch` (issue #157). The order matters: the branch is created
 * before the base is set, so a non-null `baseBranch` implies the branch existed
 * at set time. It may not still exist when the member finally spawns (retire,
 * restart, not-yet-re-cut), so {@link memberBaseNotReady} re-checks branch
 * existence against git as ground truth at gate time (#231).
 *
 * A ready member is not safe to spawn until its base is set, but the mirror
 * insert that makes it `ready` pokes the Auto-Runner immediately — before this
 * async reconcile finishes. So the pick is gated, not merely ordered: while a
 * ready Epic member's `baseBranch` is still null, {@link awaitsBase} returns
 * true and `AutoRunner.pickNext` skips it. Once this reconcile sets the base
 * (branch already created), the gate opens and the member forks from
 * `epic/<ref>`. Tickets with no derivable Epic are never gated — they keep
 * today's per-Run behaviour.
 *
 * The branch is solely Harmonic's: no agent creates or switches it (ADR-0023).
 * Members merge onto the integration branch via the one merge policy (ADR-0001,
 * #382) and the whole-Epic integrate + retire trigger (#161) fires from the poll;
 * this unit owns the create/reuse/retire operations, and wires create/reuse + the gate.
 */
export class EpicIntegrationCoordinator {
  /**
   * The ready-frontier member refs of the last reconcile's derived Epics — the
   * set {@link awaitsBase} consults to tell an Epic member awaiting its base
   * from an ordinary ready Task (whose null `baseBranch` is normal and must
   * stay pickable). Recomputed each reconcile, like the poller's scan cache.
   */
  private readyMemberRefs = new Set<number>();
  /**
   * The refs of every leaf-most Epic the last reconcile derived — the durable
   * membership signal {@link memberBaseNotReady} gates on so a member is held
   * before its integration branch is even cut (issue #334 pre-cut race), while a
   * non-Epic (nesting spine) parent stays unrecognised and is never gated.
   * Refreshed each reconcile, and re-derived on demand from persisted tickets
   * when a gate query names a ref this stale set does not yet know.
   */
  private leafEpicRefs = new Set<number>();
  private latestTickets: Ticket[] = [];
  private operations = new EpicOperations();

  constructor(
    private readonly tasks: TaskService,
    private readonly workingDir: string,
    private readonly git: EpicGit = Git,
    private readonly onError: (msg: string) => void = logger.error,
    /**
     * The whole-Epic integrate trigger (issue #161). Absent ⇒ no automatic integrate (the
     * base-set half of the lifecycle runs unchanged, #159). When present, each
     * poll offers every derived Epic for a integrate attempt — a level trigger that
     * no-ops until every member is `completed` and the integrated whole Verifies.
     * Usually attached after construction via {@link attachIntegrateTrigger} so its
     * `retire` callback can close over this same coordinator's retire method
     * without a construction cycle.
     */
    private epicIntegrate?: EpicIntegrateTrigger,
    private epicRefresh?: EpicRefreshTrigger,
  ) {}

  /** Attach (or replace) the whole-Epic integrate trigger after construction (issue
   * #161). The manager builds the integrate coordinator with a `retire` bound to this
   * instance's {@link retireIntegrationBranch}, then wires it back in here. */
  attachIntegrateTrigger(trigger: EpicIntegrateTrigger): void {
    this.epicIntegrate = trigger;
  }

  attachRefreshTrigger(trigger: EpicRefreshTrigger): void {
    this.epicRefresh = trigger;
  }

  /**
   * Handle one observed default-branch advance from Harmonic's own merge path
   * — the edge trigger. The poll loop drives the same convergence level-triggered
   * (see {@link reconcile}); both share {@link refreshDriftedEpics} so an Epic
   * already containing `defaultBranch` is skipped and neither path can diverge.
   */
  async refreshAfterDefaultBranchAdvance(defaultBranch: string): Promise<void> {
    if (!this.epicRefresh) return;
    const tickets = this.latestTickets.length > 0
      ? this.latestTickets
      : await persistedTickets(await this.tasks.list(), await this.tasks.listTrackerContainers());
    await this.refreshDriftedEpics(defaultBranch, deriveLeafEpics(tickets));
  }

  /**
   * Merge `defaultBranch` forward into every derived Epic whose integration
   * branch EXISTS and has fallen behind it. Drift is cheap to detect: the Epic
   * is behind iff `defaultBranch` is not already an ancestor of `epic/<ref>`.
   * Skipping the contained ones keeps this idempotent and off the per-branch
   * FIFO. One Epic's failure is logged, never allowed to abort the rest.
   */
  private async refreshDriftedEpics(defaultBranch: string, epics: readonly { ref: number }[]): Promise<void> {
    if (!this.epicRefresh) return;
    for (const epic of epics) {
      const branch = integrationBranchName(epic.ref);
      if (!(await this.git.branchExists(this.workingDir, branch))) continue;
      if (await this.git.isAncestor(this.workingDir, defaultBranch, branch)) continue;
      try {
        await this.epicRefresh.refresh({ ref: epic.ref, repoDir: this.workingDir, defaultBranch });
      } catch (err) {
        this.onError(`epic ${epic.ref} integration refresh failed: ${String(err)}`);
      }
    }
  }

  attachOperations(operations: EpicOperations): void {
    this.operations = operations;
  }

  async reconcile(tickets: Ticket[], mirrored: TaskRow[]): Promise<void> {
    this.latestTickets = tickets;
    const mirroredWithDeps = mirrored.length > 0 ? await this.tasks.listWithDeps({ workspaceId: mirrored[0]!.workspaceId ?? undefined }) : [];
    const readinessByRef = new Map<number, { agentWorkable: boolean }>();
    for (const task of mirroredWithDeps) {
      if (task.origin === 'mirrored' && task.trackerRef !== null) {
        readinessByRef.set(task.trackerRef, { agentWorkable: task.agentWorkable });
      }
    }
    const epics = deriveLeafEpics(tickets, readinessByRef);
    this.leafEpicRefs = new Set(epics.map((epic) => epic.ref));
    const readyRefs = new Set<number>();
    for (const epic of epics) for (const ref of epic.ready) readyRefs.add(ref);
    // Publish the gate set before any await so a racing pick already sees these
    // refs as base-pending (their `baseBranch` is still null until below).
    this.readyMemberRefs = readyRefs;

    // The "default branch" an integration branch is cut from and refreshed
    // against is the working dir's symbolic HEAD — the same branch a Run's base
    // resolves to today (issue #157). Detached HEAD (a concurrent afk-direct
    // Run, issue #152) yields null: defer this poll. Resolved at most once and
    // memoised, shared by the currency refresh and the base-set half below.
    let cachedDefault: string | null | undefined;
    const defaultBranchOnce = async (): Promise<string | null> => {
      if (cachedDefault === undefined) cachedDefault = await this.git.symbolicBranch(this.workingDir);
      return cachedDefault;
    };

    // Level-triggered epic-branch currency: every poll, merge develop forward
    // into any live `epic/<ref>` that has fallen behind — from ANY source of
    // drift (a direct commit, a revert, an external push), not just Harmonic's
    // own merges. Runs BEFORE the ready-frontier early return, since a behind
    // Epic with no ready members still needs catching up. No-op without a
    // refresh trigger, so the per-branch FIFO stays untouched in that case.
    if (this.epicRefresh) {
      const defaultBranch = await defaultBranchOnce();
      if (defaultBranch !== null) await this.refreshDriftedEpics(defaultBranch, epics);
    }

    // Nothing to base and no integrate trigger ⇒ no work this poll (preserves #159's
    // no-op when the whole-Epic integrate isn't wired). With a integrate trigger present we
    // must run even with an empty ready frontier: an Epic whose members are all
    // `completed` has no ready members yet still needs its integrate attempt.
    if (readyRefs.size === 0 && this.epicIntegrate === undefined) return;

    const byRef = new Map<number, TaskRow>();
    for (const task of mirrored) {
      if (task.trackerRef != null) byRef.set(task.trackerRef, task);
    }
    const defaultBranch = await defaultBranchOnce();
    if (defaultBranch === null) {
      // Detached working dir (a concurrent afk-direct Run): we can't safely cut a
      // durable branch off a transient OID this poll, so skip the base-set half.
      // The spawn gate ({@link memberBaseNotReady}) reads branch existence from
      // git directly, so a member whose `epic/<ref>` already exists is unaffected
      // by this detach — only brand-new members awaiting their first cut wait.
      return;
    }

    for (const epic of epics) {
      // Base-set half (#159): cut/reuse the integration branch and point each
      // ready member at it. Only Epics with a ready frontier need this.
      if (epic.ready.length > 0) {
        const branch = integrationBranchName(epic.ref);
        try {
          await this.operations.run({
            repoDir: this.workingDir,
            epicRef: epic.ref,
            type: 'cut',
            attributes: { 'epic.integration_branch': branch },
            work: () => this.ensureIntegrationBranch(branch, defaultBranch),
          });
          for (const memberRef of epic.ready) {
            const task = byRef.get(memberRef);
            if (!task) continue;
            // Re-read live state: the snapshot predates this poll's picks, so a
            // member the Auto-Runner already spawned reads `running` here even if
            // the snapshot said `ready` — its base is frozen, leave it.
            const live = await this.tasks.get(task.id);
            if (PRE_SPAWN.has(live.state) && live.baseBranch !== branch) {
              await this.tasks.setBaseBranch(live.id, branch);
            }
          }
        } catch (err) {
          // One Epic's git hiccup must not starve its siblings' base assignment.
          const reason = `integration branch reconcile failed: ${String(err)}`;
          this.operations.fail({ repoDir: this.workingDir, epicRef: epic.ref, reason });
          this.onError(`epic ${epic.ref} ${reason}`);
        }
      }

      // Integrate half (#161): offer the Epic for a whole-Epic integrate. Fire-and-forget —
      // a whole-Epic Verification can take minutes and must not stall the poll
      // loop; the coordinator's own in-flight guard prevents a redundant second
      // attempt while one is running. Its outcome (integrate/escalate/wait) is the
      // coordinator's to surface; here only an unexpected throw is logged.
      if (this.epicIntegrate) {
        const members = await Promise.all(
          epic.members.map(async (ref) => {
            const task = byRef.get(ref);
            return reduceMemberState(task ? await this.tasks.get(task.id) : undefined);
          }),
        );
        void this.epicIntegrate
          .submit({ ref: epic.ref, members, memberRefs: epic.members })
          .catch((err) => this.onError(`epic ${epic.ref} whole-Epic integrate attempt failed: ${String(err)}`));
      }
    }
  }

  /**
   * The member refs of a derived leaf Epic from the most recent scan (ADR-0018,
   * #438), for the operator force-integrate to snapshot onto the stored record;
   * `[]` when the Epic isn't in the last scan (never reconciled, or gone).
   */
  membersOf(epicRef: number): number[] {
    return deriveLeafEpics(this.latestTickets).find((epic) => epic.ref === epicRef)?.members ?? [];
  }

  /**
   * Whether `task` is a ready Epic member still awaiting its integration branch
   * base — the Auto-Runner's pick gate (issue #159). True only for a mirrored
   * Task that is a ready-frontier member of a derived Epic and whose `baseBranch`
   * is not yet set; once {@link reconcile} sets the base (branch already
   * created), this returns false and the member becomes pickable. An ordinary
   * ready Task (no Epic) is never gated — its null base is the normal case.
   */
  awaitsBase(task: TaskRow): boolean {
    return (
      task.origin === 'mirrored' &&
      task.baseBranch == null &&
      task.trackerRef != null &&
      this.readyMemberRefs.has(task.trackerRef)
    );
  }

  /**
   * Whether a member is not yet safe to spawn a worktree Run for — the broader
   * gate consulted by BOTH the Auto-Runner pick and the Runner's start funnel
   * (so no member forks off a missing integration branch, hand-started or auto).
   * True when either:
   *
   *  - its base is still unresolved ({@link awaitsBase}: a ready member the
   *    reconcile hasn't pointed at its integration branch yet, #159); or
   *  - its base IS an `epic/<ref>` integration branch that does not currently
   *    exist in git — the branch was retired, lost to a restart, or not re-cut
   *    yet, so `git worktree add` off it would fast-fail `invalid reference`.
   *    Forking is deferred (transient) until a reconcile re-cuts it.
   *
   * Branch existence is asked of git directly, at gate time (#231): the branch
   * is the real precondition a worktree fork needs, so we test it as ground
   * truth rather than trusting a per-poll set derived from the ready frontier.
   * That set wedged a member whenever the frontier emptied (all members
   * assigned, running, completed, or a failed member holding its claim) and
   * gated every member on a detached working-dir HEAD — neither of which
   * reflects whether the fork target actually exists.
   *
   * A non-mirrored Task, or a member whose base is an ordinary (non-Epic)
   * branch, is never gated here. On a git error the member is gated (fail
   * closed, deferred) rather than forked off an unvouched-for base.
   */
  async memberBaseNotReady(task: TaskRow): Promise<boolean> {
    if (task.origin !== 'mirrored') return false;
    // Ready-frontier arm (issue #159): a member the last reconcile recognised as
    // ready but has not yet been based.
    if (this.awaitsBase(task)) return true;
    // Durable-membership arm (issue #334): once an Epic's integration branch has
    // been cut, EVERY mirrored member under it (`mapRef` = the Epic ref, set at
    // mirror time) must fork from `epic/<ref>`, never develop — including one
    // picked in the poke-race window before this reconcile retargets its base
    // (base still null, `readyMemberRefs` not yet published), which is how a
    // member slipped the frontier arm above and forked off develop. Fall back to
    // the base branch's own encoded ref for a base-set member whose `mapRef` is
    // unset (a member merging onto its `epic/<ref>` integration branch).
    const epicRef = task.mapRef ?? parseIntegrationBranch(task.baseBranch);
    if (epicRef === null) return false;
    const branch = integrationBranchName(epicRef);
    try {
      const exists = await this.git.branchExists(this.workingDir, branch);
      // Already retargeted onto its integration branch: gated iff the branch has
      // since gone (retire / restart / degraded scan, #231 — transient).
      if (task.baseBranch === branch) return !exists;
      // Not yet retargeted (null / develop / a stale branch), branch already cut:
      // gate until the reconcile points the base at it.
      if (exists) return true;
      // Branch not cut yet: gate only when `mapRef` names a real leaf-most Epic in
      // the current scan. This closes the pre-cut race (issue #334) — a member
      // mirrored and picked in the window before the reconcile cuts its branch is
      // held rather than forked off develop — WITHOUT bricking a mirrored ticket
      // whose parent is a nesting "spine" (its `epic/<ref>` is never cut), which
      // stays unrecognised and runs normally.
      return await this.isLeafEpic(epicRef, task.workspaceId);
    } catch (err) {
      this.onError(`epic ${epicRef} integration branch existence check failed: ${String(err)}`);
      return true; // fail closed: never fork off an unvouched base
    }
  }

  /**
   * Whether `epicRef` is a leaf-most Epic in the current scan. Fast path: the
   * cache the last reconcile refreshed. On a miss — the pre-cut race window,
   * where a member was mirrored (its Epic's tickets persisted) but the reconcile
   * that registers the Epic has not run yet — re-derive from the persisted
   * tickets the mirror already wrote, so a genuine new member is recognised
   * immediately. A non-Epic (spine) parent is absent from the derivation, so it
   * is never gated and never bricks; the re-derive refreshes the cache for the
   * rest of the pass.
   */
  private async isLeafEpic(epicRef: number, workspaceId: number | null): Promise<boolean> {
    if (this.leafEpicRefs.has(epicRef)) return true;
    const listArg = workspaceId == null ? undefined : { workspaceId };
    const tickets = await persistedTickets(
      await this.tasks.list(listArg),
      await this.tasks.listTrackerContainers(workspaceId ?? undefined),
    );
    this.leafEpicRefs = new Set(deriveLeafEpics(tickets).map((epic) => epic.ref));
    return this.leafEpicRefs.has(epicRef);
  }

  /**
   * Create the integration branch from `defaultBranch` when absent; reuse it
   * as-is when it already exists — idempotent, and deliberately never reset:
   * members have already forked from it and merge their work onto it, so moving
   * it would strand that work.
   */
  private async ensureIntegrationBranch(branch: string, defaultBranch: string): Promise<void> {
    if (await this.git.branchExists(this.workingDir, branch)) return;
    await this.git.createBranch(this.workingDir, branch, defaultBranch);
  }

  /**
   * Retire an Epic's integration branch (the retire half of the Harmonic-owned
   * lifecycle, ADR-0023) once its Epic has fully integrated. Idempotent: a no-op
   * when the branch is already gone. The whole-Epic integrate that triggers this
   * is owned by the EpicIntegrateCoordinator (#161); #159 owns the operation.
   */
  async retireIntegrationBranch(epicRef: number): Promise<void> {
    const branch = integrationBranchName(epicRef);
    // The default branch an integration branch retires into is the working dir's
    // symbolic HEAD (issue #157); a detached HEAD can't name it, so defer — retire
    // is idempotent and re-runs on the next integrate/reconcile pass.
    const defaultBranch = await this.git.symbolicBranch(this.workingDir);
    if (defaultBranch === null) return;
    if (!(await this.git.branchExists(this.workingDir, branch))) return;
    if ((await this.git.branchCheckedOutAt(this.workingDir, branch)) !== null) return;
    if (!(await this.git.isAncestor(this.workingDir, defaultBranch, branch))) return;
    await this.git.deleteBranch(this.workingDir, branch);
  }
}
