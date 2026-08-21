import type { RunRow } from '../db/schema.js';
import type { SessionStore } from './sessions.js';
import type { RunStore } from './runs.js';
import type { WorkContextLeaseStore } from './work-context-leases.js';
import {
  decideRetirement,
  DEFAULT_RETENTION,
  type RetentionConfig,
  type RetirementCause,
} from './session-retirement.js';

/** Removes a git worktree (`Git.removeWorktree`), injected so the coordinator
 * stays free of the git module and can be unit-tested with a spy. */
export type RemoveWorktree = (repoDir: string, worktreePath: string) => Promise<void>;

/**
 * The synchronous settle-hook `RunSettleCoordinator` calls right after it
 * releases a Run's Work Context lease (issue #148) — the seam that lets settle
 * record a Session's retirement intent without depending on the concrete
 * coordinator. {@link SessionRetirementCoordinator} implements it; the dependency
 * is optional, so every settle path that predates #148 keeps working unchanged.
 */
export interface SessionRetirementHook {
  onRunSettled(run: RunRow, cause: RetirementCause, now?: number): void;
}

/**
 * Session retirement (issue #148, reliability-design Unit C) — **the sole owner
 * of builder-worktree removal.**
 *
 * A worktree Session's checkout is retained through the human-rejection window
 * so a reject-and-continue lands in the same workspace, and its builder worktree
 * is removed **only** when the Session retires — never at `finalizeWorkspace` /
 * reaching `terminal`. This coordinator is what closes that loop, in two halves:
 *
 *  - {@link onRunSettled} — the **synchronous** settle-hook. Every terminal Run
 *    disposition funnels through `RunSettleCoordinator.settle`, which calls this
 *    right after it releases the Work Context lease (so the two are ordered: the
 *    lease is gone before we decide the Session's fate). It only *records the
 *    intent* — marks the Session `idle` (retained under a deadline) or `retiring`
 *    (removal owed) — because settle is synchronous and worktree removal is not.
 *  - {@link drain} — the **asynchronous** removal pass. Sweeps `idle` Sessions
 *    whose retention deadline has lapsed into `retiring`, then removes every
 *    `retiring` Session's builder worktree and marks it `retired`. Idempotent and
 *    boot-safe: a Session left `retiring` by a crash mid-removal is re-driven on
 *    the next drain. Run at boot, on a periodic tick, and after settles.
 *
 * Removal is **coordinated with the Work Context lease**: `drain` never removes a
 * worktree while any Run of the Session still holds a lease on it (a continuation
 * may have transferred the lease forward — see
 * {@link WorkContextLeaseStore.transfer}); such a Session is left `retiring` for
 * a later drain, so the worktree always has one owner until it is truly free.
 */
export class SessionRetirementCoordinator {
  constructor(
    private readonly sessions: SessionStore,
    private readonly runs: RunStore,
    private readonly leases: WorkContextLeaseStore,
    private readonly removeWorktree: RemoveWorktree,
    private readonly config: RetentionConfig = DEFAULT_RETENTION,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Synchronous settle-hook: record the retirement intent for `run`'s Session
   * from the settle `cause`, right after its lease released. A landing / abandon
   * / operator-cancel marks the Session `retiring` (its worktree removal is now
   * owed); a reject / other ending marks it `idle` under the matching retention
   * deadline. A no-op when the Run has no Session, its Session is already
   * retiring/retired, or the Session row has gone — so it never crashes settle.
   */
  onRunSettled(run: RunRow, cause: RetirementCause, now: number = this.clock()): void {
    if (run.sessionRowId == null) return;
    let session;
    try {
      session = this.sessions.get(run.sessionRowId);
    } catch {
      return; // Session write was best-effort at dispatch; nothing to retire.
    }
    if (session.status === 'retiring' || session.status === 'retired') return; // decided already
    const action = decideRetirement(cause, now, this.config);
    if (action.kind === 'retire') {
      this.sessions.beginRetiring(session.id, action.reason, now);
    } else {
      this.sessions.markIdle(session.id, action.retireDeadline, action.reason, now);
    }
  }

  /**
   * Asynchronous removal drain (issue #148): sweep `idle`-past-deadline Sessions
   * into `retiring`, then remove every `retiring` Session's builder worktree and
   * mark it `retired`. Returns how many Sessions it retired. Idempotent and safe
   * to call repeatedly — at boot, on a periodic tick, or after a settle.
   */
  async drain(now: number = this.clock()): Promise<number> {
    // 1. Retention deadlines: an idle Session whose window lapsed is owed removal.
    for (const session of this.sessions.listRetentionDue(now)) {
      this.sessions.beginRetiring(session.id, session.retireReason ?? 'retention-ttl', now);
    }
    // 2. Remove the worktree of every Session owed removal, then retire it.
    let retired = 0;
    for (const session of this.sessions.listRetiring()) {
      // Lease coordination: never tear down a worktree a live Run still leases
      // (a continuation may hold/have-transferred it). Leave it `retiring` for a
      // later drain — the lease releases when that Run settles.
      if (await this.leaseHeld(session.id)) continue;
      if (session.worktreePath && session.worktreeRepoDir) {
        // Best-effort: an already-gone worktree (crash between removal and the
        // `retired` write, or a manual cleanup) must not wedge retirement.
        await this.removeWorktree(session.worktreeRepoDir, session.worktreePath).catch(() => {});
      }
      this.sessions.markRetired(session.id, now);
      retired++;
    }
    return retired;
  }

  /** Whether any Run of the Session still holds a Work Context lease — the gate
   * that keeps `drain` from removing a worktree with a live owner. */
  private async leaseHeld(sessionRowId: number): Promise<boolean> {
    for (const run of await this.runs.listForSession(sessionRowId)) {
      if ((await this.leases.getByOwner(run.id)) !== undefined) return true;
    }
    return false;
  }
}
