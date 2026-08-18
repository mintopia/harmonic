import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { deriveEpics } from '../domain/epic-derivation.js';
import type { Ticket } from '../tracker/adapter.js';
import { Git } from './git.js';

/**
 * The integration branch Harmonic cuts for an Epic (ADR-0024): `epic/<ref>`,
 * keyed on the Epic ticket's tracker ref. Deterministic and derivable, so the
 * branch's own existence is the only state — no new grouping entity is stored
 * (ADR-0024), and re-entry recomputes the same name.
 */
export function integrationBranchName(epicRef: number): string {
  return `epic/${epicRef}`;
}

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface EpicGit {
  /** The branch HEAD points at, or `null` on a detached HEAD (never the literal `HEAD`). */
  symbolicBranch(dir: string): Promise<string | null>;
  branchExists(dir: string, name: string): Promise<boolean>;
  createBranch(dir: string, name: string, startPoint: string): Promise<unknown>;
  deleteBranch(dir: string, name: string): Promise<unknown>;
}

/**
 * Task states that predate a worktree Run's spawn. Only these can be retargeted
 * at an integration branch: once a Run spawns, its base is resolved and frozen
 * (issue #157), so re-pointing the column would be a no-op at best and confuse a
 * re-attempt's carried-forward base at worst.
 */
const PRE_SPAWN: ReadonlySet<string> = new Set(['draft', 'blocked', 'ready']);

/**
 * The per-Epic integration-branch lifecycle, owned by Harmonic (issue #159,
 * ADR-0023/0024). Once per poll, {@link reconcile} derives the leaf-most Epics
 * from the scan (issue #158) and, for each Epic with a ready frontier, ensures
 * its integration branch exists (cut once from the default branch, reused
 * idempotently thereafter) and *then* points each ready member's mirrored Task
 * at it via `baseBranch` (issue #157). The order matters: the branch is created
 * before the base is set, so a non-null `baseBranch` always implies the branch
 * exists — the invariant {@link awaitsBase} relies on to gate the Auto-Runner.
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

  constructor(
    private readonly tasks: TaskService,
    private readonly workingDir: string,
    private readonly git: EpicGit = Git,
    private readonly onError: (msg: string) => void = (msg) => console.error(msg),
  ) {}

  async reconcile(tickets: Ticket[], mirrored: TaskRow[]): Promise<void> {
    const epics = deriveEpics(tickets);
    const readyRefs = new Set<number>();
    for (const epic of epics) for (const ref of epic.ready) readyRefs.add(ref);
    // Publish the gate set before any await so a racing pick already sees these
    // refs as base-pending (their `baseBranch` is still null until below).
    this.readyMemberRefs = readyRefs;
    if (readyRefs.size === 0) return;

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
    if (defaultBranch === null) return;

    for (const epic of epics) {
      if (epic.ready.length === 0) continue;
      const branch = integrationBranchName(epic.ref);
      try {
        await this.ensureIntegrationBranch(branch, defaultBranch);
        for (const memberRef of epic.ready) {
          const task = byRef.get(memberRef);
          if (!task) continue;
          // Re-read live state: the snapshot predates this poll's picks, so a
          // member the Auto-Runner already spawned reads `running` here even if
          // the snapshot said `ready` — its base is frozen, leave it.
          const live = this.tasks.get(task.id);
          if (PRE_SPAWN.has(live.state) && live.baseBranch !== branch) {
            this.tasks.setBaseBranch(live.id, branch);
          }
        }
      } catch (err) {
        // One Epic's git hiccup must not starve its siblings' base assignment.
        this.onError(`epic ${epic.ref} integration branch reconcile failed: ${String(err)}`);
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
    if (!(await this.git.branchExists(this.workingDir, branch))) return;
    await this.git.deleteBranch(this.workingDir, branch);
  }
}
