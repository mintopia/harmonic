import { and, asc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { epicMergeEvents, type EpicMergeEventRow } from '../db/schema.js';
import type { MergeStepEvent } from '../execution/merge-policy.js';

export interface PersistedEpicMergeEvent {
  seq: number;
  ts: number;
  step: MergeStepEvent;
}

function deserialize(row: EpicMergeEventRow): PersistedEpicMergeEvent {
  return { seq: row.seq, ts: row.ts, step: JSON.parse(row.payload) as MergeStepEvent };
}

/** The persisted step log of one Epic's current integration merge, for merge visibility. */
export class EpicMergeEventStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /** Drop the prior integration's steps so a fresh integration starts a clean log. */
  clear(workspaceId: number, epicRef: number): Promise<void> {
    return this.db.write(async (db) => {
      await db
        .delete(epicMergeEvents)
        .where(and(eq(epicMergeEvents.workspaceId, workspaceId), eq(epicMergeEvents.epicRef, epicRef)))
        .run();
    });
  }

  /** Append one step, assigning the next monotonic `seq` (1-based). */
  append(workspaceId: number, epicRef: number, step: MergeStepEvent): Promise<PersistedEpicMergeEvent> {
    return this.db.write(async (db) => {
      const seq =
        ((
          await db
            .select({ n: sql<number>`coalesce(max(${epicMergeEvents.seq}), 0)` })
            .from(epicMergeEvents)
            .where(and(eq(epicMergeEvents.workspaceId, workspaceId), eq(epicMergeEvents.epicRef, epicRef)))
            .get()
        )?.n ?? 0) + 1;
      const row = await db
        .insert(epicMergeEvents)
        .values({ workspaceId, epicRef, seq, ts: Date.now(), payload: JSON.stringify(step) })
        .returning()
        .get();
      return deserialize(row);
    });
  }

  /** One Epic's steps in `seq` order. */
  async list(workspaceId: number, epicRef: number): Promise<PersistedEpicMergeEvent[]> {
    const rows = await this.db.read((db) =>
      db
        .select()
        .from(epicMergeEvents)
        .where(and(eq(epicMergeEvents.workspaceId, workspaceId), eq(epicMergeEvents.epicRef, epicRef)))
        .orderBy(asc(epicMergeEvents.seq))
        .all(),
    );
    return rows.map(deserialize);
  }
}
