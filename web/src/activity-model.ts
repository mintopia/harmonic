// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { ActivityProcess, Cost, AttemptUsage, AttemptUsageEvent } from './types.js';

/**
 * The Activity view's attention model (issue #52). Every in-flight process is
 * sorted into one of three tiers so the fleet re-ranks by what the operator
 * should look at first — the view holds no state of its own (CONTEXT.md:
 * Activity), so the ranking is a pure function of the snapshot + live deltas.
 *
 * - **Needs you**: an afk Run that escalated to a human (issue #33), or any
 *   process past its context window (degrading — a human should intervene).
 *   These are the only rows that genuinely block on the operator; #55 adds the
 *   resolve action, #54 the pin.
 * - **High load**: a process running hot — context fill at or above
 *   `HIGH_LOAD_FILL` but still under the window. The "watch this one" tier.
 * - **Steady**: everything else, including any process whose window is
 *   unconfigured (no threshold to judge it against — honest, never a fake %).
 */
export const ATTENTION_TIERS = ['needs-you', 'high-load', 'steady'] as const;
export type AttentionTier = (typeof ATTENTION_TIERS)[number];

/** Context fill (fraction of the configured window) that marks a process "running hot". */
export const HIGH_LOAD_FILL = 0.75;

const TIER_LABELS: Record<AttentionTier, string> = {
  'needs-you': 'Needs you',
  'high-load': 'High load',
  steady: 'Steady',
};
export function tierLabel(tier: AttentionTier): string {
  return TIER_LABELS[tier];
}

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

export function attentionTier(process: ActivityProcess): AttentionTier {
  if (process.escalated) return 'needs-you';
  const fill = contextFillFraction(process);
  if (fill === null) return 'steady';
  if (fill >= 1) return 'needs-you';
  if (fill >= HIGH_LOAD_FILL) return 'high-load';
  return 'steady';
}

const TIER_RANK: Record<AttentionTier, number> = { 'needs-you': 0, 'high-load': 1, steady: 2 };

/**
 * Re-rank the fleet by attention: tier first, then context fill (fullest
 * first, unknown-fill last), then the longest-running process (oldest
 * `startedAt`) first. Pure — returns a new array, never mutates the input.
 */
export function rankActivity(processes: ActivityProcess[]): ActivityProcess[] {
  return [...processes].sort((a, b) => {
    const tier = TIER_RANK[attentionTier(a)] - TIER_RANK[attentionTier(b)];
    if (tier !== 0) return tier;
    const fa = contextFillFraction(a);
    const fb = contextFillFraction(b);
    if (fa !== fb) {
      if (fa === null) return 1;
      if (fb === null) return -1;
      return fb - fa;
    }
    return a.startedAt - b.startedAt;
  });
}

/** The Activity toolbar's type segments (issue #54): the fleet, just Runs, or just Chats. */
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
 * The toolbar's filter (issue #54): narrow by process type and/or Workspace.
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
 * The Activity toolbar's sort modes (issue #54). 'attention' is the default —
 * the tiered ranker above; the rest order by a single live metric, largest
 * first, with the "Needs you" tier always pinned on top (see `sortActivity`).
 */
export const ACTIVITY_SORTS = ['attention', 'cost', 'context', 'tokens', 'elapsed'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

const SORT_LABELS: Record<ActivitySort, string> = {
  attention: 'Attention',
  cost: 'Cost',
  context: 'Context',
  tokens: 'Tokens',
  elapsed: 'Elapsed',
};
export function sortLabel(sort: ActivitySort): string {
  return SORT_LABELS[sort];
}

/**
 * The sortable metric for a process under a non-attention sort, or null when it
 * can't be known honestly (unpriced Cost, unconfigured window, no tokens yet) —
 * a null always sorts last, never a fake zero. Elapsed is always knowable.
 */
function sortMetric(process: ActivityProcess, sort: ActivitySort, now: number): number | null {
  switch (sort) {
    case 'cost':
      return process.cost?.totalUsd ?? null;
    case 'context':
      return contextFillFraction(process);
    case 'tokens':
      return usageTotalTokens(process.usage);
    case 'elapsed':
      return elapsedMs(process, now);
    case 'attention':
      return null; // unused — attention has its own ranker
  }
}

/** Split the fleet into its pinned "Needs you" tier and everything else — the
 * partition both the metric sorter and the section grouping share (issue #54). */
function partitionNeedsYou(processes: ActivityProcess[]): [ActivityProcess[], ActivityProcess[]] {
  const needsYou: ActivityProcess[] = [];
  const rest: ActivityProcess[] = [];
  for (const p of processes) (attentionTier(p) === 'needs-you' ? needsYou : rest).push(p);
  return [needsYou, rest];
}

/**
 * Order the fleet for display (issue #54). 'attention' defers to `rankActivity`
 * (tier, then fill, then age). Every other sort orders by its live metric —
 * largest first, unknown last, oldest-first on a tie — but keeps the whole
 * "Needs you" tier pinned above the sorted rest, so an escalation never scrolls
 * out of view. Pure — returns a new array, never mutates the input.
 */
export function sortActivity(processes: ActivityProcess[], sort: ActivitySort, now: number): ActivityProcess[] {
  if (sort === 'attention') return rankActivity(processes);
  const byMetric = (a: ActivityProcess, b: ActivityProcess) => {
    const ma = sortMetric(a, sort, now);
    const mb = sortMetric(b, sort, now);
    if (ma !== mb) {
      if (ma === null) return 1;
      if (mb === null) return -1;
      return mb - ma;
    }
    return a.startedAt - b.startedAt;
  };
  const [needsYou, rest] = partitionNeedsYou(processes);
  return [...rankActivity(needsYou), ...rest.sort(byMetric)];
}

/** One rendered band in the Activity table: a header label plus its rows. */
export interface ActivitySection {
  /** Stable key + identity: a tier name under 'attention', else 'needs-you' / 'sorted'. */
  key: string;
  label: string;
  /** True for the pinned "Needs you" band — the view tints its header accent. */
  pinned: boolean;
  rows: ActivityProcess[];
}

/**
 * Group the (already-filtered) fleet into the table's display bands (issue #54).
 * Under 'attention', the three attention tiers (empty ones dropped). Under a
 * metric sort, the pinned "Needs you" band above a single "By {metric}" band —
 * so escalations stay pinned whatever the sort. Pure.
 */
export function activitySections(processes: ActivityProcess[], sort: ActivitySort, now: number): ActivitySection[] {
  const sorted = sortActivity(processes, sort, now);
  if (sort === 'attention') {
    return ATTENTION_TIERS.map((tier) => ({
      key: tier,
      label: tierLabel(tier),
      pinned: tier === 'needs-you',
      rows: sorted.filter((p) => attentionTier(p) === tier),
    })).filter((s) => s.rows.length > 0);
  }
  const [needsYou, rest] = partitionNeedsYou(sorted);
  const sections: ActivitySection[] = [];
  if (needsYou.length > 0)
    sections.push({ key: 'needs-you', label: tierLabel('needs-you'), pinned: true, rows: needsYou });
  if (rest.length > 0)
    sections.push({ key: 'sorted', label: `By ${sortLabel(sort).toLowerCase()}`, pinned: false, rows: rest });
  return sections;
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
    if (c.totalUsd === null) incomplete = true; // usage existed but none priced
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
 * Merge a live `attempt_usage` delta into the matching Run row (by `attemptId`),
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

/** The summary strip's figures (issue #52): the one-glance fleet readout above the rows. */
export interface ActivitySummary {
  /** In-flight Runs (afk work) — the machine-ceiling numerator. */
  runningCount: number;
  /** Rows in the "Needs you" tier — the count that should pull the eye. */
  needsYouCount: number;
  /** Fleet Cost as an honest floor across every process; null when nothing is priceable. */
  cost: Cost | null;
  /** Summed average token throughput across the fleet. */
  tokensPerSecond: number;
  /** Runs in flight against the Machine Ceiling (the global concurrent-Run cap). */
  ceiling: { running: number; max: number };
}

export function activitySummary(
  processes: ActivityProcess[],
  machineCeiling: number,
  now: number,
): ActivitySummary {
  const runningCount = processes.filter((p) => p.type === 'attempt').length;
  return {
    runningCount,
    needsYouCount: processes.filter((p) => attentionTier(p) === 'needs-you').length,
    cost: sumCosts(processes.map((p) => p.cost)),
    tokensPerSecond: processes.reduce((sum, p) => sum + tokensPerSecond(p, now), 0),
    ceiling: { running: runningCount, max: machineCeiling },
  };
}
