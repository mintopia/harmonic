import type { AppContext } from './app.js';
import type { RunRow } from '../db/schema.js';
import type { TaskWithDeps } from '../domain/tasks.js';
import { costOfUsages, resolvePrices, type Cost } from '../execution/pricing.js';
import type { RunUsage } from '../execution/usage.js';

/**
 * API shapes for runs and tasks, used by both the REST routes and the
 * WebSocket broadcasts so the SPA sees one format (issue 15). Cost is
 * derived from stored Usage on every read — never persisted — so a price
 * change reprices all history.
 */

const parseUsage = (raw: string | null): RunUsage | null => (raw ? (JSON.parse(raw) as RunUsage) : null);

const pricesOf = (ctx: AppContext) => resolvePrices(ctx.configStore.get().prices);

export type ApiRun = Omit<RunRow, 'usage'> & { usage: RunUsage | null; cost: Cost | null };

export function runToApi(ctx: AppContext, run: RunRow): ApiRun {
  const usage = parseUsage(run.usage);
  return { ...run, usage, cost: costOfUsages([usage], pricesOf(ctx)) };
}

export type ApiTask = TaskWithDeps & { cost: Cost | null };

/** A task's Cost sums ALL its runs — retries and failed attempts included. */
export function taskToApi(ctx: AppContext, task: TaskWithDeps): ApiTask {
  const usages = ctx.runs.listForTask(task.id).map((run) => parseUsage(run.usage));
  return { ...task, cost: costOfUsages(usages, pricesOf(ctx)) };
}

/** Cost of an arbitrary set of runs against the live price table. */
export function costOfRuns(ctx: AppContext, runs: RunRow[]): Cost | null {
  return costOfUsages(runs.map((run) => parseUsage(run.usage)), pricesOf(ctx));
}
