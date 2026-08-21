import type { Ticket, TrackerAdapter } from './adapter.js';
import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';

/**
 * The tracker-facing half of afk mirrored-Task execution (issue #32). Owns the
 * advisory GitHub assignment: the pick-time foreign-assignee filter, the
 * flip→recheck→claim pre-spawn step, and the per-poll reconcile that drives the
 * tracker toward Harmonic's local intent (running ⇒ claimed, handed-back ⇒
 * un-assigned). The assignment is never a lock — the local ready→running flip
 * is (see the Auto-Runner) — so every write here is best-effort and idempotent,
 * and a dropped one is retried on the next reconcile.
 */
export class MirrorCoordinator {
  private adapter: TrackerAdapter | null = null;
  private byRef = new Map<number, Ticket>();
  /** Harmonic's own tracker login — the assignee `claim` places; resolved once. Null until then. */
  private me: string | null = null;

  /** One coordinator per tracker-enabled Workspace (issue #45): its scan cache and reconcile see that Workspace's Tasks only. */
  constructor(
    private readonly tasks: TaskService,
    private readonly workspaceId: number,
  ) {}

  /** Cache the poll's adapter + scan and resolve our identity, before any pick reads {@link foreignAssignee}. */
  async observe(adapter: TrackerAdapter, scan: Ticket[]): Promise<void> {
    this.adapter = adapter;
    this.byRef = new Map(scan.map((t) => [t.number, t]));
    if (this.me === null) this.me = await adapter.whoami().catch(() => null);
  }

  /**
   * From the last scan: does this mirrored Task carry an assignee Harmonic
   * didn't place? Native/unknown → false. Before our identity resolves, any
   * assignee reads as foreign (skip rather than run something a human may own).
   */
  foreignAssignee(task: TaskRow): boolean {
    if (task.origin !== 'mirrored' || task.trackerRef == null) return false;
    const ticket = this.byRef.get(task.trackerRef);
    return ticket ? this.foreign(ticket) : false;
  }

  /** An assignee Harmonic didn't place. Before our identity resolves, any assignee counts (skip, don't run a human's). */
  private foreign(ticket: Ticket): boolean {
    return ticket.assignees.some((a) => a !== this.me);
  }

  /** Harmonic holds the claim on this ticket. Unknowable until our identity resolves. */
  private mine(ticket: Ticket): boolean {
    return this.me !== null && ticket.assignees.includes(this.me);
  }

  /**
   * Pre-spawn step (mirrored afk): a fresh single read to catch a human who
   * grabbed the ticket since the scan, then the advisory claim. 'yield' hands
   * the ticket back to the human frontier (and refreshes the cache so the picker
   * sees the grab); a failed claim still returns 'spawn' — reconcile retries.
   */
  async recheckAndClaim(task: TaskRow): Promise<'spawn' | 'yield'> {
    if (!this.adapter || task.trackerRef == null) return 'spawn';
    const fresh = await this.adapter.readTicket({ number: task.trackerRef, title: task.prompt, state: 'open' });
    this.byRef.set(fresh.number, fresh);
    if (this.foreign(fresh)) return 'yield';
    try {
      await this.adapter.claim(fresh);
    } catch {
      // Advisory only — proceed to spawn and let reconcile retry the assignment.
    }
    return 'spawn';
  }

  /**
   * Drive the tracker toward local intent, once per poll: re-place a dropped
   * claim on a still-running Task, and un-assign a handed-back one (a failed /
   * cancelled Run, or a runtime escalation — including the crash sweep that
   * fails orphaned runs at boot). Completion is left to the close path (D5).
   */
  async reconcile(): Promise<void> {
    if (!this.adapter) return;
    for (const task of await this.tasks.list({ workspaceId: this.workspaceId })) {
      if (task.origin !== 'mirrored' || task.trackerRef == null) continue;
      const ticket = this.byRef.get(task.trackerRef);
      if (!ticket) continue;
      if (task.state === 'running' && !this.mine(ticket)) {
        await this.adapter.claim(ticket).catch(() => {});
      } else if (handedBack(task) && this.mine(ticket)) {
        await this.adapter.release(ticket).catch(() => {});
      }
    }
  }
}

/**
 * Harmonic has dropped drive back to the human frontier: a cancelled Run or a
 * runtime Escalation (issue #33). Auto-Retry now re-queues a failed afk Run
 * (failed→ready, claim held across retries), so bare `failed` is no longer a
 * hand-back — only exhausted-retries (escalated) is.
 */
function handedBack(task: TaskRow): boolean {
  return task.state === 'cancelled' || task.escalated;
}
