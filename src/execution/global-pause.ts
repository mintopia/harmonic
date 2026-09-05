import type { TaskService } from '../domain/tasks.js';
import type { Runner } from './runner.js';
import { forEachYielding } from '../reliability/yield.js';
import type { AsyncDbHandle } from '../db/async.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../logger.js';

const GLOBAL_PAUSE_KEY = 'global-pause';

interface PersistedGlobalPause {
  latched: boolean;
  taskIds: number[];
}

const persistedGlobalPauseSchema = z.object({
  latched: z.boolean(),
  taskIds: z.array(z.number().int().positive()),
});

export class GlobalPause {
  private latched = false;
  private readonly taskIds = new Set<number>();

  constructor(
    private readonly tasks: TaskService,
    private readonly runner: Pick<Runner, 'pauseForGlobal' | 'resume'>,
    private readonly db: AsyncDbHandle,
  ) {}

  get isLatched(): boolean {
    return this.latched;
  }

  async rebuild(): Promise<void> {
    const stored = await this.db.read((db) =>
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, GLOBAL_PAUSE_KEY)).get(),
    );
    let persisted: PersistedGlobalPause = { latched: false, taskIds: [] };
    if (stored) {
      try {
        const parsed = persistedGlobalPauseSchema.safeParse(JSON.parse(stored.value));
        if (parsed.success) persisted = parsed.data;
      } catch {}
    }
    this.latched = persisted.latched;
    this.taskIds.clear();
    for (const taskId of persisted.taskIds) this.taskIds.add(taskId);
  }

  async pause(): Promise<void> {
    this.latched = true;
    await this.persist();
    await forEachYielding(await this.tasks.list({ state: 'working' }), async (task) => {
      const paused = await this.runner.pauseForGlobal(task.id);
      if (paused) {
        await this.track(task.id);
      } else {
        logger.info('Global pause skipped task', { taskId: task.id, reason: 'not actively running' });
      }
    });
  }

  async resume(): Promise<void> {
    if (!this.latched) return;
    const taskIds = [...this.taskIds];
    this.latched = false;
    this.taskIds.clear();
    await this.persist();
    await forEachYielding(taskIds, async (taskId) => {
      const resumed = await this.runner.resume(taskId, 'global pause cleared');
      if (!resumed) logger.info('Global resume skipped task', { taskId, reason: 'no paused attempt' });
    });
  }

  async track(taskId: number): Promise<void> {
    if (!this.latched) {
      const resumed = await this.runner.resume(taskId, 'global pause cleared');
      if (!resumed) logger.info('Global resume skipped task', { taskId, reason: 'no paused attempt' });
      return;
    }
    if (this.taskIds.has(taskId)) return;
    this.taskIds.add(taskId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify({ latched: this.latched, taskIds: [...this.taskIds] } satisfies PersistedGlobalPause);
    await this.db.write((db) =>
      db
        .insert(settings)
        .values({ key: GLOBAL_PAUSE_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run(),
    );
  }
}
