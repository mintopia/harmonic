import type { TicketRef, TrackerAdapter } from './adapter.js';
import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { forEachYielding } from '../reliability/yield.js';

/** Owns the advisory tracker assignment for mirrored Tasks; every write is best-effort and idempotent, never a lock. */
export class MirrorCoordinator {
  private adapter: TrackerAdapter | null = null;

  private readonly advertised = new Map<number, 'claimed' | 'released'>();

  /** One coordinator per tracker-enabled Workspace. */
  constructor(
    private readonly tasks: TaskService,
    private readonly workspaceId: number,
  ) {}

  /** Remember the adapter used for best-effort assignment writes. */
  async observe(adapter: TrackerAdapter): Promise<void> {
    this.adapter = adapter;
  }

  /** Advertise the local claim after the lock; a failed write does not block the Task. */
  async advertiseClaim(task: TaskRow): Promise<void> {
    if (!this.adapter || task.trackerRef == null) return;
    try {
      await this.adapter.claim(ticketRef(task, task.trackerRef));
      this.advertised.set(task.id, 'claimed');
    } catch {
    }
  }

  /** Once per poll: re-place a dropped claim on a working Task, un-assign a handed-back one. */
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

function handedBack(task: TaskRow): boolean {
  return task.state === 'cancelled' || task.state === 'escalated';
}
