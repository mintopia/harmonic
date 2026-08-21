import { TASK_STATES } from './types.js';

export interface RunStateCount {
  state: string;
  count: number;
}

/** Run-state distribution in canonical TASK_STATES order, with zero-count states dropped.
 *  Any states present in the input but not in TASK_STATES are appended after the known ones,
 *  in input order, also dropping zeros. */
export function orderedRunStates(runsByState: Record<string, number>): RunStateCount[] {
  const known: RunStateCount[] = [];
  for (const state of TASK_STATES) {
    const count = runsByState[state] ?? 0;
    if (count > 0) known.push({ state, count });
  }
  const unknown: RunStateCount[] = [];
  for (const [state, count] of Object.entries(runsByState)) {
    if ((TASK_STATES as readonly string[]).includes(state)) continue;
    if (count > 0) unknown.push({ state, count });
  }
  return [...known, ...unknown];
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
 * Failure rate (0..1, ADR-0028): `failedRuns / total`, failed-only. `failedRuns`
 * is the backend's already-honest numerator (review-rejected Runs excluded).
 * null when there are no Runs — the caller shows "—", never a fabricated 0%.
 */
export function failureRate(failedRuns: number, total: number): number | null {
  if (total <= 0) return null;
  return failedRuns / total;
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
