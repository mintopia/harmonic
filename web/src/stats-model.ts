import type { AttemptSummary, Cost } from './types.js';
import type { DayCost } from './components/costChart-model.js';
import type { AttemptsPerTask, CostPerMergedTask, MergedDay } from './components/flow-throughput-model.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One row of the per-Workspace spend breakdown (ADR-0014): billable tokens stay
 * split in/out, and cost is null-sticky (a floor, never a fake $0). */
export interface WorkspaceStats {
  workspaceId: number;
  name: string;
  cost: Cost | null;
  inputTokens: number;
  outputTokens: number;
  tasks: number;
  /** Failed-only rate over the Workspace's non-cancelled attempts; null when it ran none. */
  failureRate: number | null;
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
  /** Attempt-grain aggregates grouped by owning Workspace, ordered by cost. */
  byWorkspace: WorkspaceStats[];
  /** Verification verdicts at verification-attempt grain; only the critic split
   * feeds the card — command verdicts are never folded in (ADR-0014 §4). */
  verdicts: { critic: VerdictCounts; command: VerdictCounts };
  /** How settled Tasks left the merge gate (ADR-0014 §5). */
  gateOutcomes: GateOutcomes;
  /** Guardrail trip counts keyed by dimension; a dimension that never tripped is absent. */
  guardrailTrips: Record<string, number>;
  /** Tasks merged per calendar day (server tz), only days that held a merge; ordered by day. */
  tasksMergedByDay: MergedDay[];
  /** Distribution of attempts-to-settle over merged Tasks (self-heal depth); 1 is best. */
  attemptsPerTask: AttemptsPerTask;
  /** Merged spend ÷ merged Tasks with reverted/abandoned spend beside it; costs null-stick (ADR-0008). */
  costPerMergedTask: CostPerMergedTask;
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

/** Critic/command verdict tallies at verification-attempt grain (ADR-0014 §4):
 * pass / block / inconclusive, never folded together. */
export interface VerdictCounts {
  pass: number;
  block: number;
  inconclusive: number;
}

/** How settled Tasks left the merge gate (ADR-0014 §5): auto-merged, escalated
 * to a human, or merged-then-reverted on a red post-merge check. */
export interface GateOutcomes {
  autoMerged: number;
  escalated: number;
  revertedOnRed: number;
}

/** One labelled magnitude row of a Verification-card panel. */
export interface CountRow {
  key: string;
  count: number;
}

/** Fixed pass / block / inconclusive order so the critic donut keeps a stable
 * legend even when a bucket is empty. Only the critic feeds this card; command
 * verdicts are never folded in (ADR-0014 §4). */
const VERDICT_ORDER = ['pass', 'block', 'inconclusive'] as const;
export function criticVerdictSlices(critic: VerdictCounts): CountRow[] {
  return VERDICT_ORDER.map((key) => ({ key, count: critic[key] }));
}

export function criticVerdictTotal(critic: VerdictCounts): number {
  return critic.pass + critic.block + critic.inconclusive;
}

/** Fixed auto-merged / escalated / reverted-on-red order; the three sum to the
 * settled-Task total (`settledTaskTotal`) so the gate reconciles visibly. */
const GATE_ORDER = ['autoMerged', 'escalated', 'revertedOnRed'] as const;
export function gateOutcomeBars(gate: GateOutcomes): CountRow[] {
  return GATE_ORDER.map((key) => ({ key, count: gate[key] }));
}

/** Every settled Task left the gate exactly once, so the outcomes sum to the
 * settled-Task total — the denominator the gate bars reconcile against. */
export function settledTaskTotal(gate: GateOutcomes): number {
  return gate.autoMerged + gate.escalated + gate.revertedOnRed;
}

/** Guardrail trips ranked by count (largest first, ties by dimension key), with
 * never-tripped dimensions absent — the shape the guardrail bars render. */
export function guardrailTripBars(trips: Record<string, number>): CountRow[] {
  return Object.entries(trips)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** True when no verification, gate, or guardrail activity fell in range — the
 * Verification card shows an empty state rather than three blank panels. */
export function verificationCardEmpty(
  critic: VerdictCounts,
  gate: GateOutcomes,
  trips: Record<string, number>,
): boolean {
  return (
    criticVerdictTotal(critic) === 0 && settledTaskTotal(gate) === 0 && guardrailTripBars(trips).length === 0
  );
}
