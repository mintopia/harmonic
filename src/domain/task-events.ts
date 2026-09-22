import { asc, desc, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { taskEvents, type TaskEventRow } from '../db/schema.js';

export interface PersistedTaskEvent {
  id: number;
  taskId: number;
  ts: number;
  payload: unknown;
}

function deserialize(row: TaskEventRow): PersistedTaskEvent {
  return { id: row.id, taskId: row.taskId, ts: row.ts, payload: JSON.parse(row.payload) };
}

/** Append-only lifecycle log for a Task action with no owning Attempt; the
 * ticket timeline renders these rows alongside `attempt_events`, same mapping. */
export class TaskEventStore {
  constructor(private readonly db: AsyncDbHandle) {}

  appendEvent(taskId: number, payload: unknown): Promise<PersistedTaskEvent> {
    return this.db.write(async (db) => {
      const row = await db.insert(taskEvents).values({ taskId, ts: Date.now(), payload: JSON.stringify(payload) }).returning().get();
      return deserialize(row);
    });
  }

  async listEvents(taskId: number, limit?: number): Promise<PersistedTaskEvent[]> {
    const rows = await this.db.read((db) => {
      const query = db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.ts), asc(taskEvents.id));
      return limit === undefined ? query.all() : query.limit(limit).all();
    });
    return rows.map(deserialize);
  }

  /** Newest-first, capped — matches the ticket timeline's other sources. */
  async listRecent(taskId: number, limit: number): Promise<PersistedTaskEvent[]> {
    const rows = await this.db.read((db) =>
      db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(desc(taskEvents.ts), desc(taskEvents.id)).limit(limit).all(),
    );
    return rows.map(deserialize);
  }
}
