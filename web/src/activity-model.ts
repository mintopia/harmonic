// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { ActivityProcess, Cost, AttemptUsage, AttemptUsageEvent, ProcessNode } from './types.js';

/** Context fill (fraction of the configured window) that marks a process "running hot". */
export const HIGH_LOAD_FILL = 0.75;

/**
 * Context-window fill as a fraction, or null when it can't be known honestly:
 * an unknown token count, or a known count with no configured window (the
 * gauge shows raw tokens instead). Deliberately unclamped past 1 — a process
 * can genuinely exceed its window, and that over-fill is exactly the "Needs
 * you" signal below (mirrors conversation-telemetry-model's `computeContextUsage`).
 */
export function contextFillFraction(process: ActivityProcess): number | null {
  const { contextTokens, contextWindow } = process;
  if (contextTokens === null || contextWindow === null) return null;
  return contextTokens / contextWindow;
}

/** The Activity toolbar's type segments: the fleet, just Attempts, or just Chats. */
export const ACTIVITY_TYPE_FILTERS = ['all', 'attempts', 'chats'] as const;
export type ActivityTypeFilter = (typeof ACTIVITY_TYPE_FILTERS)[number];

/** The toolbar's filter state: a type segment plus an optional single-Workspace narrowing. */
export interface ActivityFilter {
  type: ActivityTypeFilter;
  /** Narrow to one Workspace, or null for every Workspace (the view spans them). */
  workspaceId: number | null;
}

/** The default — the whole fleet, every Workspace. */
export const NO_ACTIVITY_FILTER: ActivityFilter = { type: 'all', workspaceId: null };

/**
 * The toolbar's filter: narrow by process type and/or Workspace.
 * Order-preserving so a later sort owns ordering outright. An empty result is
 * honest — the view shows a filtered empty state rather than a stale list.
 */
export function filterActivity(processes: ActivityProcess[], filter: ActivityFilter): ActivityProcess[] {
  return processes.filter((p) => {
    if (filter.type === 'attempts' && p.type !== 'attempt') return false;
    if (filter.type === 'chats' && p.type !== 'chat') return false;
    if (filter.workspaceId !== null && p.workspaceId !== filter.workspaceId) return false;
    return true;
  });
}

export interface FleetLane {
  process: ActivityProcess;
  node: ProcessNode | null;
  depth: number;
}

/** Place each root and its direct Subagents beneath its context-ordered root lane. */
export function fleetLanes(processes: ActivityProcess[]): FleetLane[] {
  const lanes: FleetLane[] = [];
  const roots = [...processes].sort((a, b) => {
    const aFill = contextFillFraction(a);
    const bFill = contextFillFraction(b);
    if (aFill === bFill) return a.startedAt - b.startedAt;
    if (aFill === null) return 1;
    if (bFill === null) return -1;
    return bFill - aFill;
  });
  for (const process of roots) {
    if (process.tree) {
      lanes.push({ process, node: process.tree, depth: 0 });
      for (const child of process.tree.children)
        lanes.push({ process, node: child, depth: 1 });
    }
    else lanes.push({ process, node: null, depth: 0 });
  }
  return lanes;
}

function subagentCount(node: ProcessNode | null): number {
  if (!node) return 0;
  return node.children.reduce((count, child) => count + 1 + subagentCount(child), 0);
}

/** One entry in the Workspace filter dropdown. */
export interface WorkspaceOption {
  id: number;
  name: string;
}

/** The distinct Workspaces present in the fleet, sorted by name — the filter's options. */
export function activityWorkspaces(processes: ActivityProcess[]): WorkspaceOption[] {
  const byId = new Map<number, string>();
  for (const p of processes) if (!byId.has(p.workspaceId)) byId.set(p.workspaceId, p.workspaceName);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Drop a Workspace filter that no longer matches any live Workspace. The
 * dropdown hides once a single Workspace remains, so a filter left pointing at
 * a Workspace that has since drained out would otherwise strand the table on an
 * unclearable "Nothing matches" empty state. Healing it here lets the filter
 * re-render correctly as the fleet changes.
 */
export function resolveActivityFilter(filter: ActivityFilter, workspaces: WorkspaceOption[]): ActivityFilter {
  if (filter.workspaceId === null) return filter;
  if (workspaces.some((w) => w.id === filter.workspaceId)) return filter;
  return { ...filter, workspaceId: null };
}

/**
 * Accumulated tokens for a process: the harness's own `totalTokens` when it
 * reports one, else the sum of the four counters it always reports. Null usage
 * (no tokens yet) stays null — never a fake zero (the honest-incomplete rule).
 */
export function usageTotalTokens(usage: AttemptUsage | null): number | null {
  const totals = usage?.totals;
  if (!totals) return null;
  if (totals.totalTokens !== null) return totals.totalTokens;
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/** Elapsed run time in ms, floored at 0 so clock skew never shows a negative age. */
export function elapsedMs(process: ActivityProcess, now: number): number {
  return Math.max(0, now - process.startedAt);
}

/**
 * Average token throughput since the process started (tokens ÷ elapsed
 * seconds). 0 before any tokens or before any elapsed time — an average rate,
 * summed across the fleet for the summary strip's "tok/s".
 */
export function tokensPerSecond(process: ActivityProcess, now: number): number {
  const tokens = usageTotalTokens(process.usage);
  const seconds = elapsedMs(process, now) / 1000;
  if (tokens === null || seconds <= 0) return 0;
  return tokens / seconds;
}

/**
 * Aggregate a set of Costs into one honest floor (the fleet's live Cost).
 * Null when nothing is priceable; otherwise the sum of priced totals, flagged
 * `incomplete` (a "≥" floor) if any member was incomplete or could not be
 * priced — mirrors `Task.cost` and `formatCost`'s honest-incomplete contract.
 */
export function sumCosts(costs: (Cost | null | undefined)[]): Cost | null {
  const present = costs.filter((c): c is Cost => !!c);
  if (present.length === 0) return null;
  let total: number | null = null;
  let incomplete = false;
  const modelSums: Record<string, number> = {};
  const modelNull = new Set<string>();
  for (const c of present) {
    if (c.incomplete) incomplete = true;
    if (c.totalUsd === null) incomplete = true;
    else total = (total ?? 0) + c.totalUsd;
    for (const [model, v] of Object.entries(c.byModel)) {
      if (v === null) {
        modelNull.add(model);
        incomplete = true;
      } else {
        modelSums[model] = (modelSums[model] ?? 0) + v;
      }
    }
  }
  const byModel: Record<string, number | null> = {};
  for (const model of new Set([...Object.keys(modelSums), ...modelNull])) {
    byModel[model] = modelSums[model] ?? null;
  }
  return { totalUsd: total, byModel, incomplete };
}

/**
 * Merge a live `attempt_usage` delta into the matching Attempt row (by `attemptId`),
 * refreshing its Usage, context fill, activity line, Process Tree, and Cost.
 * Returns the same array reference when nothing matches — a Conversation is
 * never touched (it has no `attemptId`), and a no-op skips a needless re-render.
 */
export function mergeRunUsage(processes: ActivityProcess[], event: AttemptUsageEvent): ActivityProcess[] {
  if (!processes.some((p) => p.type === 'attempt' && p.attemptId === event.attemptId)) return processes;
  return processes.map((p) =>
    p.type === 'attempt' && p.attemptId === event.attemptId
      ? {
          ...p,
          usage: event.usage,
          contextTokens: event.contextTokens,
          activity: event.activity,
          tree: event.tree,
          cost: event.cost,
        }
      : p,
  );
}

/** The summary strip's figures: the one-glance fleet readout above the rows. */
export interface ActivitySummary {
  /** Root Agents, one for every in-flight Attempt or Conversation. */
  agentCount: number;
  /** Every Process Tree descendant, excluding each root Agent. */
  subagentCount: number;
  /** In-flight Attempts (afk work) — the host-ceiling numerator. */
  runningCount: number;
  /** Fleet Cost as an honest floor across every process; null when nothing is priceable. */
  cost: Cost | null;
  /** Summed average token throughput across the fleet. */
  tokensPerSecond: number;
  /** Attempts in flight against the Host Ceiling (the global concurrent-Attempt cap). */
  ceiling: { running: number; max: number };
}

export function activitySummary(
  processes: ActivityProcess[],
  hostCeiling: number,
  now: number,
): ActivitySummary {
  const runningCount = processes.filter((p) => p.type === 'attempt').length;
  return {
    agentCount: processes.length,
    subagentCount: processes.reduce((count, process) => count + subagentCount(process.tree), 0),
    runningCount,
    cost: sumCosts(processes.map((p) => p.cost)),
    tokensPerSecond: processes.reduce((sum, p) => sum + tokensPerSecond(p, now), 0),
    ceiling: { running: runningCount, max: hostCeiling },
  };
}
