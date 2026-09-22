import { and, asc, eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { epicMergeEvents, type EpicMergeEventRow } from '../db/schema.js';
import type { MergeStepEvent } from '../execution/merge-policy.js';

/** One integration-branch cut, observed outside a merge (fired from
 * `EpicLifecycle.ensureIntegrationBranch`, not `runMergePolicy`). */
export type EpicBranchStep =
  | { step: 'branch-created'; branch: string; fromBranch: string; oid: string }
  | { step: 'branch-create-failed'; branch: string; fromBranch: string; error: string };

export type EpicTimelineStep = MergeStepEvent | EpicBranchStep;

export interface PersistedEpicMergeEvent {
  seq: number;
  ts: number;
  step: EpicTimelineStep;
}

function deserialize(row: EpicMergeEventRow): PersistedEpicMergeEvent {
  return { seq: row.seq, ts: row.ts, step: JSON.parse(row.payload) as EpicTimelineStep };
}

/** The persisted, append-only step log of an Epic's integration-branch and
 * merge activity, for merge visibility. */
export class EpicMergeEventStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /** Append one step, assigning the next monotonic `seq` (1-based). */
  append(workspaceId: number, epicRef: number, step: EpicTimelineStep): Promise<PersistedEpicMergeEvent> {
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
