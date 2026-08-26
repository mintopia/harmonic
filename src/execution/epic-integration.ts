import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { deriveEpics } from '../domain/epic-derivation.js';
import type { MemberLandState } from '../domain/epic-land.js';
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
 * member-finish landing path (issue #163) uses it to tell an Epic member's Run
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
 * The whole-Epic land trigger (issue #161) the reconcile fires per derived Epic
 * each poll. A structural interface, not the concrete {@link EpicLandCoordinator}
 * import, so this module and the coordinator (which imports
 * {@link integrationBranchName} from here) don't form a cycle. `submit` is a
 * *level* trigger: harmless to call every poll — it no-ops until every member is
 * `completed`, and after a successful land the retired branch makes it a `noop`.
 */
export interface EpicLandTrigger {
  submit(target: { ref: number; members: MemberLandState[] }, opts?: { force?: boolean }): Promise<unknown>;
}

/** Edge-triggered default-branch refresh hook. It is deliberately separate
 * from reconcile: polls discover Epics, but only a successful develop landing
 * is allowed to request a refresh. */
export interface EpicRefreshTrigger {
  refresh(target: { ref: number; repoDir: string; defaultBranch: string }): Promise<unknown>;
}

/**
 * Reduce a member's mirrored Task to its land state for the whole-Epic land
 * decision (issue #161): `completed` once it has landed onto the integration
 * branch (Task state `done`); `blocked` when it cannot land (escalated to a
 * human, or `failed`/`cancelled`) and so holds the whole Epic back; `pending`
 * otherwise (still in progress, awaiting review, not yet started, or not mirrored).
 */
export function reduceMemberState(task: TaskRow | undefined): MemberLandState {
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
 * The merge train that lands members onto the integration branch (#160) and the
 * whole-Epic land + retire trigger (#161) arrive later in the tranche; this unit
 * owns the create/reuse/retire operations, and wires create/reuse + the gate.
 */
export class EpicIntegrationCoordinator {
  /**
   * The ready-frontier member refs of the last reconcile's derived Epics — the
   * set {@link awaitsBase} consults to tell an Epic member awaiting its base
   * from an ordinary ready Task (whose null `baseBranch` is normal and must
   * stay pickable). Recomputed each reconcile, like the poller's scan cache.
   */
  private readyMemberRefs = new Set<number>();
  private latestTickets: Ticket[] = [];
  private operations = new EpicOperations();

  constructor(
    private readonly tasks: TaskService,
    private readonly workingDir: string,
    private readonly git: EpicGit = Git,
    private readonly onError: (msg: string) => void = logger.error,
    /**
     * The whole-Epic land trigger (issue #161). Absent ⇒ no automatic land (the
     * base-set half of the lifecycle runs unchanged, #159). When present, each
     * poll offers every derived Epic for a land attempt — a level trigger that
     * no-ops until every member is `completed` and the integrated whole Verifies.
     * Usually attached after construction via {@link attachLandTrigger} so its
     * `retire` callback can close over this same coordinator's retire method
     * without a construction cycle.
     */
    private epicLand?: EpicLandTrigger,
    private epicRefresh?: EpicRefreshTrigger,
  ) {}

  /** Attach (or replace) the whole-Epic land trigger after construction (issue
   * #161). The manager builds the land coordinator with a `retire` bound to this
   * instance's {@link retireIntegrationBranch}, then wires it back in here. */
  attachLandTrigger(trigger: EpicLandTrigger): void {
    this.epicLand = trigger;
  }

  attachRefreshTrigger(trigger: EpicRefreshTrigger): void {
    this.epicRefresh = trigger;
  }

  /**
   * Handle one observed default-branch advance. This is an edge hook called by
   * the landing path, never by the poll loop. Derived Epics without a current
   * integration branch are retired or closed and are intentionally skipped.
   */
  async refreshAfterDefaultBranchAdvance(defaultBranch: string): Promise<void> {
    if (!this.epicRefresh) return;
    const tickets = this.latestTickets.length > 0
      ? this.latestTickets
      : await persistedTickets(await this.tasks.list(), await this.tasks.listTrackerContainers());
    const epics = deriveEpics(tickets);
    for (const epic of epics) {
      const branch = integrationBranchName(epic.ref);
      if (!(await this.git.branchExists(this.workingDir, branch))) continue;
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
    const epics = deriveEpics(tickets, readinessByRef);
    const readyRefs = new Set<number>();
    for (const epic of epics) for (const ref of epic.ready) readyRefs.add(ref);
    // Publish the gate set before any await so a racing pick already sees these
    // refs as base-pending (their `baseBranch` is still null until below).
    this.readyMemberRefs = readyRefs;
    // Nothing to base and no land trigger ⇒ no work this poll (preserves #159's
    // no-op when the whole-Epic land isn't wired). With a land trigger present we
    // must run even with an empty ready frontier: an Epic whose members are all
    // `completed` has no ready members yet still needs its land attempt.
    if (readyRefs.size === 0 && this.epicLand === undefined) return;

    const byRef = new Map<number, TaskRow>();
    for (const task of mirrored) {
      if (task.trackerRef != null) byRef.set(task.trackerRef, task);
    }
    // The "default branch" an integration branch is cut from is the working
    // dir's symbolic HEAD — the same branch a Run's base resolves to today
    // (issue #157). Detached HEAD (a concurrent afk-direct Run, issue #152)
    // yields null: defer this poll rather than anchor a durable branch on a
    // transient OID. Members stay base-pending (gated), retried next poll.
    const defaultBranch = await this.git.symbolicBranch(this.workingDir);
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

      // Land half (#161): offer the Epic for a whole-Epic land. Fire-and-forget —
      // a whole-Epic Verification can take minutes and must not stall the poll
      // loop; the coordinator's own in-flight guard prevents a redundant second
      // attempt while one is running. Its outcome (land/escalate/wait) is the
      // coordinator's to surface; here only an unexpected throw is logged.
      if (this.epicLand) {
        const members = await Promise.all(
          epic.members.map(async (ref) => {
            const task = byRef.get(ref);
            return reduceMemberState(task ? await this.tasks.get(task.id) : undefined);
          }),
        );
        void this.epicLand
          .submit({ ref: epic.ref, members })
          .catch((err) => this.onError(`epic ${epic.ref} whole-Epic land attempt failed: ${String(err)}`));
      }
    }
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
    if (this.awaitsBase(task)) return true;
    const ref = parseIntegrationBranch(task.baseBranch);
    if (ref === null) return false;
    try {
      return !(await this.git.branchExists(this.workingDir, integrationBranchName(ref)));
    } catch (err) {
      this.onError(`epic ${ref} integration branch existence check failed: ${String(err)}`);
      return true;
    }
  }

  /**
   * Create the integration branch from `defaultBranch` when absent; reuse it
   * as-is when it already exists — idempotent, and deliberately never reset:
   * members have already forked from it and the merge train lands their work
   * onto it, so moving it would strand that work.
   */
  private async ensureIntegrationBranch(branch: string, defaultBranch: string): Promise<void> {
    if (await this.git.branchExists(this.workingDir, branch)) return;
    await this.git.createBranch(this.workingDir, branch, defaultBranch);
  }

  /**
   * Retire an Epic's integration branch (the retire half of the Harmonic-owned
   * lifecycle, ADR-0023) once its Epic has fully landed. Idempotent: a no-op
   * when the branch is already gone. The whole-Epic land that triggers this
   * arrives with the merge train (#160/#161) — #159 owns the operation, not yet
   * its trigger.
   */
  async retireIntegrationBranch(epicRef: number): Promise<void> {
    const branch = integrationBranchName(epicRef);
    const retainedBranch = await this.git.symbolicBranch(this.workingDir);
    if (retainedBranch === null) return;
    if (!(await this.git.branchExists(this.workingDir, branch))) return;
    if ((await this.git.branchCheckedOutAt(this.workingDir, branch)) !== null) return;
    if (!(await this.git.isAncestor(this.workingDir, retainedBranch, branch))) return;
    await this.git.deleteBranch(this.workingDir, branch);
  }
}
