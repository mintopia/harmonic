import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs, runEvents, tasks, type RunRow, type RunEventRow, type RunState } from '../db/schema.js';
import { DomainError } from './errors.js';
import type { ResolvedGuardrails } from './setting-override.js';
import type { PriceTable } from '../execution/pricing.js';

export interface RunEventInput {
  type: 'session_update' | 'permission_request' | 'lifecycle';
  payload: unknown;
}

/** The Guardrail state a Run captures at start (issue #126): the effective
 * config and price table, frozen so a later change can't retroactively trip it. */
export interface RunGuardrailSnapshot {
  guardrailConfig: ResolvedGuardrails;
  priceTable: PriceTable;
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

  create(taskId: number, snapshot?: RunGuardrailSnapshot): RunRow {
    const attempt =
      (this.db
        .select({ n: sql<number>`coalesce(max(${runs.attempt}), 0)` })
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .get()?.n ?? 0) + 1;
    return this.db
      .insert(runs)
      .values({
        taskId,
        attempt,
        state: 'running',
        startedAt: Date.now(),
        guardrailConfig: snapshot ? JSON.stringify(snapshot.guardrailConfig) : null,
        priceTable: snapshot ? JSON.stringify(snapshot.priceTable) : null,
      })
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
   * Running-Run count per owning Workspace, for the Auto-Runner's per-Workspace
   * concurrency cap (ADR-0012, issue #60). Runs carry no Workspace column, so
   * the count joins through the Task; the same running-Run source as
   * {@link countRunning}, so the per-Workspace tallies and the Machine-Ceiling
   * total can never disagree. Workspaces with no running Run are absent (read as 0).
   */
  countRunningByWorkspace(): Map<number, number> {
    const rows = this.db
      .select({ workspaceId: tasks.workspaceId, n: sql<number>`count(*)` })
      .from(runs)
      .innerJoin(tasks, eq(runs.taskId, tasks.id))
      .where(eq(runs.state, 'running'))
      .groupBy(tasks.workspaceId)
      .all();
    const counts = new Map<number, number>();
    for (const row of rows) if (row.workspaceId != null) counts.set(row.workspaceId, row.n);
    return counts;
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
  // liveUsage is the Activity view's snapshot (streamed as `run_usage`), not
  // part of the agent-facing run shape.
  const { liveUsage: _liveUsage, ...rest } = run;
  return {
    ...rest,
    usage: run.usage ? JSON.parse(run.usage) : null,
    guardrailConfig: run.guardrailConfig ? JSON.parse(run.guardrailConfig) : null,
    priceTable: run.priceTable ? JSON.parse(run.priceTable) : null,
  };
}
