// Explicit .js extension: this module is shared with the node-side test
// project, whose nodenext resolution requires it (Vite maps .js → .ts).

/**
 * Pure derivations for the Epic summary page (issue #412, ADR-0015): shapes
 * the whole-Epic Usage & statistics card and the per-child-Task token bar so
 * `EpicPage.tsx` stays declarative. Composes the existing `stats-model.ts` /
 * `cost.ts` helpers rather than re-deriving their formulas (ADR-0008).
 */

import type { Cost, ModelUsage } from './types.js';
import type { Stats, UsageBar } from './stats-model.js';
import { cacheHitRate, failureRate, subagentShare, usageBars } from './stats-model.js';
import { formatAvgCostPerRun, formatCost } from './cost.js';
import { fmtElapsed } from './board-sections-model.js';

const NONE = '—';

function formatPct(rate: number | null): string {
  return rate === null ? NONE : `${Math.round(rate * 100)}%`;
}

/** Sum of every tool's call count (`stats.toolCalls` is keyed by tool name). */
function totalToolCalls(toolCalls: Record<string, number>): number {
  return Object.values(toolCalls).reduce((sum, n) => sum + n, 0);
}

/** The Stats fields the Usage & statistics card needs — narrower than the full
 * `/api/stats` response so a fixture/test need not build the whole shape. */
export type EpicUsageStats = Pick<
  Stats,
  'attemptCount' | 'failedAttempts' | 'durationMs' | 'totals' | 'models' | 'agents' | 'toolCalls' | 'cost'
>;

/** The Usage & statistics card's headline figures, pre-formatted so the
 * component renders them as-is — `'—'` is the honest empty value throughout,
 * never a fabricated 0/0%. */
export interface EpicUsageSummary {
  /** False when the Epic's children have never run (all-zero Stats) — the
   * caller shows a restrained empty note instead of the grid. */
  hasActivity: boolean;
  totalCost: string;
  /** The total is a floor (some tokens couldn't be priced) — the "≥ floor" note. */
  costIncomplete: boolean;
  attemptCount: number;
  avgCostPerTask: string;
  failureRatePct: string;
  durationP50: string;
  durationP95: string;
  tokensIn: number;
  tokensOut: number;
  cacheHitPct: string;
  subagentSharePct: string;
  toolCalls: number;
  /** Per-model token bars (largest first), the shape `TokenTypeBar` renders. */
  modelBars: UsageBar[];
}

/** Shapes an Epic's all-time child-Task Stats (ADR-0008) into the card's
 * headline figures. `childCount` is the Epic's own Task-list count (not
 * `attemptCount`, which is Attempt-grain) — the honest denominator for a
 * per-Task average. */
export function epicUsageSummary(stats: EpicUsageStats, childCount: number): EpicUsageSummary {
  return {
    hasActivity: stats.attemptCount > 0,
    totalCost: formatCost(stats.cost) ?? NONE,
    costIncomplete: stats.cost?.incomplete ?? false,
    attemptCount: stats.attemptCount,
    avgCostPerTask: formatAvgCostPerRun(stats.cost, childCount) ?? NONE,
    failureRatePct: formatPct(failureRate(stats.failedAttempts, stats.attemptCount)),
    durationP50: stats.durationMs ? fmtElapsed(stats.durationMs.p50) : NONE,
    durationP95: stats.durationMs ? fmtElapsed(stats.durationMs.p95) : NONE,
    tokensIn: stats.totals?.inputTokens ?? 0,
    tokensOut: stats.totals?.outputTokens ?? 0,
    cacheHitPct: formatPct(cacheHitRate(stats.totals)),
    subagentSharePct: formatPct(subagentShare(stats.agents)),
    toolCalls: totalToolCalls(stats.toolCalls),
    modelBars: usageBars(stats.models),
  };
}

/** One class of a stacked token bar (the ADR-0014 four-class split: input,
 * output, cache-read, cache-write), coloured with the shared `--hm-token-*`
 * vocabulary (TicketPage's `TOKEN_SEGMENTS`, TableView's `TokenTypeBar`). */
export interface TokenBarSegment {
  key: 'input' | 'output' | 'cacheRead' | 'cacheWrite';
  label: string;
  fill: string;
  value: number;
  /** Share of the bar's own total (0..100); 0 on an all-zero/null bucket. */
  pct: number;
}

const TOKEN_SEGMENT_META: { key: TokenBarSegment['key']; label: string; fill: string; field: keyof ModelUsage }[] = [
  { key: 'input', label: 'input', fill: 'bg-token-input', field: 'inputTokens' },
  { key: 'output', label: 'output', fill: 'bg-token-output', field: 'outputTokens' },
  { key: 'cacheRead', label: 'cache read', fill: 'bg-token-cache-read', field: 'cacheReadTokens' },
  { key: 'cacheWrite', label: 'cache write', fill: 'bg-token-cache-write', field: 'cacheWriteTokens' },
];

/** A child Task row's stacked token bar (issue #412): the four token classes
 * of its `taskUsage` totals, each segment's share of that row's own total.
 * `totals` is null when the Task hasn't run, or its usage fetch failed — every
 * segment reads 0/0% rather than throwing, so the row degrades to an empty bar. */
export function tokenBarSegments(totals: ModelUsage | null | undefined): TokenBarSegment[] {
  const total = totals
    ? totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    : 0;
  return TOKEN_SEGMENT_META.map(({ key, label, fill, field }) => {
    const value = totals?.[field] ?? 0;
    return { key, label, fill, value: typeof value === 'number' ? value : 0, pct: total > 0 ? ((typeof value === 'number' ? value : 0) / total) * 100 : 0 };
  });
}

/** True when a child row's token bar has nothing to plot — the caller shows
 * a muted dash rather than a zero-width bar. */
export function tokenBarEmpty(segments: TokenBarSegment[]): boolean {
  return segments.every((s) => s.value === 0);
}

/** `Cost | null` → a compact per-row cost string, `'—'` when unpriceable — the
 * child-Task table column shares this with `formatCost` but never renders `null`. */
export function rowCost(cost: Cost | null): string {
  return formatCost(cost) ?? NONE;
}
