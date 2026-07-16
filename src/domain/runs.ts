import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs, runEvents, type RunRow, type RunEventRow, type RunState } from '../db/schema.js';
import { DomainError } from './errors.js';

export interface RunEventInput {
  type: 'session_update' | 'permission_request' | 'lifecycle';
  payload: unknown;
}

export interface PersistedRunEvent {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export class RunStore {
  constructor(private readonly db: Db) {}

  create(taskId: number): RunRow {
    const attempt =
      (this.db
        .select({ n: sql<number>`coalesce(max(${runs.attempt}), 0)` })
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .get()?.n ?? 0) + 1;
    return this.db
      .insert(runs)
      .values({ taskId, attempt, state: 'running', startedAt: Date.now() })
      .returning()
      .get();
  }

  get(id: number): RunRow {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    if (!row) throw new DomainError('not_found', `run ${id} not found`);
    return row;
  }

  listForTask(taskId: number): RunRow[] {
    return this.db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.attempt)).all();
  }

  update(id: number, patch: Partial<RunRow>): RunRow {
    return this.db.update(runs).set(patch).where(eq(runs.id, id)).returning().get()!;
  }

  /** Terminal transition; ignored if the run already left `running` (e.g. cancelled). */
  finish(id: number, state: Exclude<RunState, 'running'>, patch: Partial<RunRow> = {}): RunRow {
    const current = this.get(id);
    if (current.state !== 'running') return current;
    return this.update(id, { ...patch, state, finishedAt: Date.now() });
  }

  appendEvent(runId: number, event: RunEventInput): PersistedRunEvent {
    const seq =
      (this.db
        .select({ n: sql<number>`coalesce(max(${runEvents.seq}), 0)` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .get()?.n ?? 0) + 1;
    const row = this.db
      .insert(runEvents)
      .values({ runId, seq, ts: Date.now(), type: event.type, payload: JSON.stringify(event.payload) })
      .returning()
      .get();
    return deserializeEvent(row);
  }

  listEvents(runId: number): PersistedRunEvent[] {
    this.get(runId); // 404 on unknown run
    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq))
      .all()
      .map(deserializeEvent);
  }

  countRunning(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(runs)
        .where(eq(runs.state, 'running'))
        .get()?.n ?? 0
    );
  }

  /**
   * Finished runs that never got a per-model usage split — their run-end
   * collection raced the harness's session-log flush. Candidates for the
   * boot-time backfill.
   */
  listUsageBackfillCandidates(): RunRow[] {
    return this.db
      .select()
      .from(runs)
      .where(and(ne(runs.state, 'running'), isNotNull(runs.sessionId)))
      .all()
      .filter((run) => {
        if (!run.usage) return true;
        const models = (JSON.parse(run.usage) as { models?: Record<string, unknown> }).models;
        return !models || Object.keys(models).length === 0;
      });
  }

  /**
   * Crash recovery, run at boot: any run still marked running was orphaned
   * by a restart. Fail it (reason "interrupted") and return it so the
   * caller can fail its task (and notify) — never silently re-run on a
   * possibly dirty working directory.
   */
  markInterrupted(): RunRow[] {
    const orphans = this.db.select().from(runs).where(eq(runs.state, 'running')).all();
    for (const run of orphans) {
      this.update(run.id, { state: 'failed', reason: 'interrupted', finishedAt: Date.now() });
    }
    return orphans;
  }
}

export function deserializeEvent(row: RunEventRow): PersistedRunEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}

export function serializeRun(run: RunRow): Record<string, unknown> {
  return { ...run, usage: run.usage ? JSON.parse(run.usage) : null };
}
