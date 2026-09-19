import type { TicketRef, TrackerAdapter } from './adapter.js';
import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { forEachYielding } from '../reliability/yield.js';
import { attempted, bestEffort, errorMessage } from '../error-handling.js';
import { logger } from '../logger.js';

const ticketGone = (err: unknown): boolean => /\b404\b|not found/i.test(errorMessage(err));

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
    const adapter = this.adapter;
    const trackerRef = task.trackerRef;
    if (!adapter || trackerRef == null) return;
    const claimed = await bestEffort(() => adapter.claim(ticketRef(task, trackerRef)), {
      op: 'tracker.advertiseClaim',
      level: 'warn',
      notFoundIf: ticketGone,
      context: { taskId: task.id, workspaceId: this.workspaceId, trackerRef, adapter: adapter.name },
    });
    if (claimed) this.advertised.set(task.id, 'claimed');
  }

  /** Once per poll: re-place a dropped claim on a working Task, un-assign a handed-back one. */
  async reconcile(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) return;
    let failed = 0;
    await forEachYielding(await this.tasks.list({ workspaceId: this.workspaceId }), async (task) => {
      if (task.origin !== 'mirrored' || task.trackerRef == null) return;
      const ticket = ticketRef(task, task.trackerRef);
      if (task.state === 'working') {
        if (this.advertised.get(task.id) === 'claimed') return;
        const result = await attempted(() => adapter.claim(ticket), {
          op: 'tracker.reconcile.claim',
          level: 'debug',
          notFoundIf: ticketGone,
          context: {
            taskId: task.id,
            workspaceId: this.workspaceId,
            trackerRef: task.trackerRef ?? undefined,
            adapter: adapter.name,
            state: task.state,
          },
        });
        if (result.ok) this.advertised.set(task.id, 'claimed');
        else if (result.kind === 'failed') failed++;
      } else if (handedBack(task)) {
        if (this.advertised.get(task.id) === 'released') return;
        const result = await attempted(() => adapter.release(ticket), {
          op: 'tracker.reconcile.release',
          level: 'debug',
          notFoundIf: ticketGone,
          context: {
            taskId: task.id,
            workspaceId: this.workspaceId,
            trackerRef: task.trackerRef ?? undefined,
            adapter: adapter.name,
            state: task.state,
          },
        });
        if (result.ok) this.advertised.set(task.id, 'released');
        else if (result.kind === 'failed') failed++;
      }
    });
    if (failed > 0) {
      logger.warn('tracker.reconcile: assignment writes failed', {
        op: 'tracker.reconcile',
        outcome: 'failed',
        workspaceId: this.workspaceId,
        failed,
      });
    }
  }
}

function ticketRef(task: TaskRow, number: number): TicketRef {
  return { number, title: task.prompt, state: 'open' };
}

function handedBack(task: TaskRow): boolean {
  return task.state === 'cancelled' || task.state === 'escalated';
}
