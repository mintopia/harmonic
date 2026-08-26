import type { TicketRef, TrackerAdapter } from './adapter.js';
import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { forEachYielding } from '../reliability/yield.js';

/**
 * The tracker-facing half of mirrored-Task execution (issue #32). Owns the
 * advisory tracker assignment: the post-lock claim advertisement and the
 * per-poll reconcile that drives the
 * tracker toward Harmonic's local intent (working ⇒ claimed, handed-back ⇒
 * un-assigned). The assignment is never a lock — the local ready→running flip
 * is (see the Auto-Runner) — so every write here is best-effort and idempotent,
 * and a dropped one is retried on the next reconcile.
 */
export class MirrorCoordinator {
  private adapter: TrackerAdapter | null = null;

  /**
   * The advisory state this coordinator has last *successfully* advertised per
   * Task id — the cheap local idempotency guard (issue #232). No tracker read
   * participates (ADR-0030 forbids the old `mine()` assignee read); this records
   * only what *we* wrote, so a per-poll reconcile skips a claim/release whose
   * desired advertised state is unchanged. A failed write is not recorded, so it
   * retries next reconcile; a running→handed-back→running Task flips the recorded
   * state each way and re-advertises correctly.
   */
  private readonly advertised = new Map<number, 'claimed' | 'released'>();

  /** One coordinator per tracker-enabled Workspace (issue #45), scoped to that Workspace's Tasks and adapter. */
  constructor(
    private readonly tasks: TaskService,
    private readonly workspaceId: number,
  ) {}

  /** Remember the adapter used for best-effort assignment writes. */
  async observe(adapter: TrackerAdapter): Promise<void> {
    this.adapter = adapter;
  }

  /**
   * Post-lock step for a mirrored Task: advertise the local claim. No
   * tracker read participates in the pick (issue #232, ADR-0030), and a failed
   * write does not block the locally claimed Task.
   */
  async advertiseClaim(task: TaskRow): Promise<void> {
    if (!this.adapter || task.trackerRef == null) return;
    try {
      await this.adapter.claim(ticketRef(task, task.trackerRef));
      this.advertised.set(task.id, 'claimed');
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
    const adapter = this.adapter;
    if (!adapter) return;
    await forEachYielding(await this.tasks.list({ workspaceId: this.workspaceId }), async (task) => {
      if (task.origin !== 'mirrored' || task.trackerRef == null) return;
      const ticket = ticketRef(task, task.trackerRef);
      if (task.state === 'working') {
        if (this.advertised.get(task.id) === 'claimed') return;
        await adapter
          .claim(ticket)
          .then(() => void this.advertised.set(task.id, 'claimed'))
          .catch(() => {});
      } else if (handedBack(task)) {
        if (this.advertised.get(task.id) === 'released') return;
        await adapter
          .release(ticket)
          .then(() => void this.advertised.set(task.id, 'released'))
          .catch(() => {});
      }
    });
  }
}

function ticketRef(task: TaskRow, number: number): TicketRef {
  return { number, title: task.prompt, state: 'open' };
}

/**
 * Harmonic has handed the ticket to a human: cancelled or escalated (ADR-0041).
 * The Attempt loop retries within its cap with the claim held, so only an
 * escalation or a cancel releases the advisory assignment.
 */
function handedBack(task: TaskRow): boolean {
  return task.state === 'cancelled' || task.state === 'escalated';
}
