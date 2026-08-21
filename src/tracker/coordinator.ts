import type { Ticket, TrackerAdapter } from './adapter.js';
import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';

/**
 * The tracker-facing half of afk mirrored-Task execution (issue #32). Owns the
 * advisory GitHub assignment: the flip→recheck→claim pre-spawn step and the
 * per-poll reconcile that drives the
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

  /** Cache the poll's adapter + scan and resolve our identity for claim reconciliation. */
  async observe(adapter: TrackerAdapter, scan: Ticket[]): Promise<void> {
    this.adapter = adapter;
    this.byRef = new Map(scan.map((t) => [t.number, t]));
    if (this.me === null) this.me = await adapter.whoami().catch(() => null);
  }

  /** Harmonic holds the claim on this ticket. Unknowable until our identity resolves. */
  private mine(ticket: Ticket): boolean {
    return this.me !== null && ticket.assignees.includes(this.me);
  }

  /**
   * Pre-spawn step (mirrored afk): refresh the cached ticket, then place the
   * advisory claim. Assignment is not an eligibility signal (issue #230,
   * ADR-0030), and a failed claim does not block the locally claimed Task.
   */
  async recheckAndClaim(task: TaskRow): Promise<void> {
    if (!this.adapter || task.trackerRef == null) return;
    const fresh = await this.adapter.readTicket({ number: task.trackerRef, title: task.prompt, state: 'open' });
    this.byRef.set(fresh.number, fresh);
    try {
      await this.adapter.claim(fresh);
    } catch {
      // Advisory only — proceed to spawn and let reconcile retry the assignment.
    }
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
