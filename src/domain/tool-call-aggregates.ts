import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { AsyncDb, AsyncDbHandle } from '../db/async.js';
import { attemptToolCalls, attempts, tasks } from '../db/schema.js';

export interface ToolCallTotals {
  byTask: Record<number, Record<string, number>>;
  byEpic: Record<number, Record<string, number>>;
}

export interface ToolCallRange {
  from: number;
  to: number;
  workspaceId?: number;
  /** Scope to one Epic's child Tasks by their rollup key (`tasks.mapRef`, issue #410). */
  epicRef?: number;
}

/**
 * Read-only rollups over the per-Attempt tool-call snapshot (ADR-0031).
 * Epic is derived from the
 * mirrored Task's parent tracker ref (`mapRef`); native and unparented Tasks
 * therefore contribute only to their Task total.
 */
export class ToolCallAggregateStore {
  constructor(private readonly db: AsyncDbHandle) {}

  async totalsForWorkspace(workspaceId: number): Promise<ToolCallTotals> {
    const rows = await this.db.read((db) =>
      db
        .select({
          taskId: tasks.id,
          epicRef: tasks.mapRef,
          toolName: attemptToolCalls.toolName,
          count: sql<number>`sum(${attemptToolCalls.count})`,
        })
        .from(attemptToolCalls)
        .innerJoin(attempts, eq(attemptToolCalls.attemptId, attempts.id))
        .innerJoin(tasks, eq(attempts.taskId, tasks.id))
        .where(eq(tasks.workspaceId, workspaceId))
        .groupBy(tasks.id, tasks.mapRef, attemptToolCalls.toolName)
        .all(),
    );

    const totals: ToolCallTotals = { byTask: {}, byEpic: {} };
    for (const row of rows) {
      addTotal(totals.byTask, row.taskId, row.toolName, row.count);
      if (row.epicRef !== null) addTotal(totals.byEpic, row.epicRef, row.toolName, row.count);
    }
    return totals;
  }
}

/**
 * Read a Stats range from the native tool-call aggregate. This accepts an
 * already-open database so the Stats route can include it in its one
 * concurrent-read snapshot (ADR-0029 §5).
 */
export async function totalsForRange(db: AsyncDb, range: ToolCallRange): Promise<ToolCallTotals> {
  const { from, to, workspaceId, epicRef } = range;
  // Optional Workspace/Epic predicates both reach `tasks` via the same join;
  // `and()` drops any `undefined`, so an unscoped read carries neither.
  const rows = await db
    .select({
      taskId: tasks.id,
      epicRef: tasks.mapRef,
      toolName: attemptToolCalls.toolName,
      count: sql<number>`sum(${attemptToolCalls.count})`,
    })
    .from(attemptToolCalls)
    .innerJoin(attempts, eq(attemptToolCalls.attemptId, attempts.id))
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(
      and(
        gte(attempts.startedAt, from),
        lte(attempts.startedAt, to),
        workspaceId === undefined ? undefined : eq(tasks.workspaceId, workspaceId),
        epicRef === undefined ? undefined : eq(tasks.mapRef, epicRef),
      ),
    )
    .groupBy(tasks.id, tasks.mapRef, attemptToolCalls.toolName)
    .all();

  const totals: ToolCallTotals = { byTask: {}, byEpic: {} };
  for (const row of rows) {
    addTotal(totals.byTask, row.taskId, row.toolName, row.count);
    if (row.epicRef !== null) addTotal(totals.byEpic, row.epicRef, row.toolName, row.count);
  }
  return totals;
}

function addTotal(totals: Record<number, Record<string, number>>, dimension: number, toolName: string, count: number): void {
  const tools = totals[dimension];
  if (tools) tools[toolName] = (tools[toolName] ?? 0) + count;
  else totals[dimension] = { [toolName]: count };
}
