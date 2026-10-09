import type { TrackerRef } from '../tracker/adapter.js';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { AsyncDb } from '../db/async.js';
import { attemptToolCalls, attempts, tasks } from '../db/schema.js';

export interface ToolCallTotals {
  byTask: Record<number, Record<string, number>>;
  byEpic: Record<string, Record<string, number>>;
}

export interface ToolCallRange {
  from: number;
  to: number;
  workspaceId?: number;
  /** Scope to one Epic's child Tasks by their rollup key (`tasks.mapRef`). */
  epicRef?: TrackerRef;
}

/** Read a Stats range from the tool-call aggregate; accepts an already-open database so the Stats route can batch its reads. */
export async function totalsForRange(db: AsyncDb, range: ToolCallRange): Promise<ToolCallTotals> {
  const { from, to, workspaceId, epicRef } = range;
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

function addTotal(totals: Record<string, Record<string, number>>, dimension: number | string, toolName: string, count: number): void {
  const tools = totals[dimension];
  if (tools) tools[toolName] = (tools[toolName] ?? 0) + count;
  else totals[dimension] = { [toolName]: count };
}
