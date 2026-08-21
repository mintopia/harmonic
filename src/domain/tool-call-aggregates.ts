import { eq, sql } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { runToolCalls, runs, tasks } from '../db/schema.js';

export interface ToolCallTotals {
  byTask: Record<number, Record<string, number>>;
  byEpic: Record<number, Record<string, number>>;
}

/**
 * Read-only rollups over the per-Run tool-call snapshot (ADR-0031). Epic is
 * derived from the mirrored Task's parent tracker ref (`mapRef`); native and
 * unparented Tasks therefore contribute only to their Task total.
 */
export class ToolCallAggregateStore {
  constructor(private readonly db: AsyncDbHandle) {}

  async totalsForWorkspace(workspaceId: number): Promise<ToolCallTotals> {
    const rows = await this.db.read((db) =>
      db
        .select({
          taskId: tasks.id,
          epicRef: tasks.mapRef,
          toolName: runToolCalls.toolName,
          count: sql<number>`sum(${runToolCalls.count})`,
        })
        .from(runToolCalls)
        .innerJoin(runs, eq(runToolCalls.runId, runs.id))
        .innerJoin(tasks, eq(runs.taskId, tasks.id))
        .where(eq(tasks.workspaceId, workspaceId))
        .groupBy(tasks.id, tasks.mapRef, runToolCalls.toolName)
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

function addTotal(totals: Record<number, Record<string, number>>, dimension: number, toolName: string, count: number): void {
  const tools = totals[dimension];
  if (tools) tools[toolName] = (tools[toolName] ?? 0) + count;
  else totals[dimension] = { [toolName]: count };
}
