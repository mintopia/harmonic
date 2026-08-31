import type { AttemptSummary, Cost } from './types.js';
import type { DayCost } from './components/costChart-model.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The `/api/stats` response (attempt-grain aggregates over from/to/workspaceId,
 *  ADR-0008/0014). Shared by the KPI panel and the attempt-activity heatmap so
 *  the one fetch contract lives in one place. */
export interface Stats {
  from: number;
  to: number;
  attemptCount: number;
  attemptsByState: Record<string, number>;
  /** Failed-only Run count (cancelled excluded); the honest failure-rate numerator. */
  failedAttempts: number;
  /** Execution failures bucketed by winning terminal disposition; empty when nothing failed. */
  failuresByReason: Record<string, number>;
  /** p50 / p95 active-execution duration (ms); null when no run has a measurable duration. */
  durationMs: { p50: number; p95: number } | null;
  totals: (ModelUsage & { totalTokens: number | null }) | null;
  models: Record<string, ModelUsage>;
  /** Per-agent-type token breakdown (root + each Subagent type); may be absent on older data. */
  agents?: Record<string, ModelUsage>;
  toolTokens?: Record<string, { outputTokens: number; cost?: number }>;
  reasoning?: { outputTokens: number; cost?: number };
  toolCalls: Record<string, number>;
  cost: Cost | null;
  series: DayCost[];
}

export interface AttemptStateCount {
  state: string;
  count: number;
}

/** The canonical AttemptSummary-state order (mirrors the server's `RUN_STATES`): live, then merged, then the failure slices. */
const ATTEMPT_STATE_ORDER = ['running', 'completed', 'failed', 'cancelled'] as const satisfies readonly AttemptSummary['state'][];

/** AttemptSummary-state distribution in canonical AttemptSummary-state order, with zero-count states dropped.
 *  Any states present in the input but not in the canonical order are appended after
 *  the known ones, in input order, also dropping zeros. */
export function orderedAttemptStates(attemptsByState: Record<string, number>): AttemptStateCount[] {
  const known: AttemptStateCount[] = [];
  for (const state of ATTEMPT_STATE_ORDER) {
    const count = attemptsByState[state] ?? 0;
    if (count > 0) known.push({ state, count });
  }
  const unknown: AttemptStateCount[] = [];
  for (const [state, count] of Object.entries(attemptsByState)) {
    if ((ATTEMPT_STATE_ORDER as readonly string[]).includes(state)) continue;
    if (count > 0) unknown.push({ state, count });
  }
  return [...known, ...unknown];
}

/**
 * The run-states breakdown for the reliability donut (ADR-0028): `failed` is
 * the backend's failed-only count and cancelled stays its own slice. Everything
 * is shown so the failure rate can be reconciled against the whole picture,
 * never a hidden number. Zero-count slices are dropped, canonical order kept.
 */
export function reliabilityStates(attemptsByState: Record<string, number>, failedAttempts: number): AttemptStateCount[] {
  return orderedAttemptStates({ ...attemptsByState, failed: failedAttempts });
}

/** One reason bucket of the failures-by-reason breakdown. */
export interface FailureReasonCount {
  reason: string;
  count: number;
}

/** The failures-by-reason breakdown ordered largest-first (ties by reason key),
 *  zero-count buckets dropped — the shape the reliability bar chart renders. */
export function orderedFailureReasons(byReason: Record<string, number>): FailureReasonCount[] {
  return Object.entries(byReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** The root-session bucket in a per-agent breakdown; everything else is a Subagent. */
export const ROOT_AGENT = 'root';

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** All four token classes of one bucket, summed — the magnitude a token bar plots. */
export const totalTokens = (u: TokenCounts): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export interface UsageBar {
  key: string;
  tokens: number;
}

/**
 * Bar rows for a per-key token breakdown (per-model, per-agent), largest
 * first, zero-token keys dropped — the shape the Stats bar charts render.
 */
export function usageBars(byKey: Record<string, TokenCounts>): UsageBar[] {
  return Object.entries(byKey)
    .map(([key, u]) => ({ key, tokens: totalTokens(u) }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
}

/**
 * Cache hit rate (0..1, ADR-0028): cache-read tokens over *all* input-side
 * tokens — `read / (input + read + write)`. The denominator includes cache-write
 * on purpose, so priming the cache counts against the rate until it pays back.
 * null when there is no usage or no input-side tokens — the caller shows "—",
 * never a fabricated 0%.
 */
export function cacheHitRate(totals: TokenCounts | null | undefined): number | null {
  if (!totals) return null;
  const denom = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  if (denom === 0) return null;
  return totals.cacheReadTokens / denom;
}

/**
 * Failure rate (0..1, ADR-0028): `failedAttempts / total`, failed-only — the
 * backend's honest numerator (cancelled Runs excluded).
 * null when there are no Runs — the caller shows "—", never a fabricated 0%.
 */
export function failureRate(failedAttempts: number, total: number): number | null {
  if (total <= 0) return null;
  return failedAttempts / total;
}

/**
 * The Subagent share of total tokens (0..1): everything not under `root`,
 * over the whole tree. null when there is no per-agent data or no tokens —
 * the caller shows "—", never a fabricated 0%.
 */
export function subagentShare(agents: Record<string, TokenCounts> | undefined): number | null {
  if (!agents) return null;
  let total = 0;
  let root = 0;
  for (const [name, u] of Object.entries(agents)) {
    const t = totalTokens(u);
    total += t;
    if (name === ROOT_AGENT) root += t;
  }
  if (total === 0) return null;
  return (total - root) / total;
}
