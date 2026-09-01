import { sumCosts, type Cost } from '../domain/pricing.js';
import { mergeUsage, type AttemptUsage } from '../execution/usage.js';
import { isExecutionFailure } from '../domain/attempt-failure.js';
import type {
  GuardrailTripRow,
  SettledTaskAttempt,
  SettleEventRow,
  TaskWorkspaceRow,
  VerificationRow,
  WorkspaceNameRow,
} from '../db/stats-reader.js';

const parseCost = (raw: string | null): Cost | null => (raw ? (JSON.parse(raw) as Cost) : null);

function dayBucket(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function terminalSettleByTask(settleEvents: SettleEventRow[]): Map<number, SettleEventRow> {
  const terminal = new Map<number, SettleEventRow>();
  for (const event of settleEvents) {
    const prior = terminal.get(event.taskId);
    if (!prior || event.ts >= prior.ts) terminal.set(event.taskId, event);
  }
  return terminal;
}

export interface DayCount {
  day: number;
  count: number;
}

/** Tasks merged per calendar day (server timezone); a Task counts once, on its merge day. Days with no merges are absent. */
export function tasksMergedByDay(settleEvents: SettleEventRow[]): DayCount[] {
  const byDay = new Map<number, number>();
  for (const settle of terminalSettleByTask(settleEvents).values()) {
    if (settle.kind !== 'merged') continue;
    const day = dayBucket(settle.ts);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay.entries()].sort(([a], [b]) => a - b).map(([day, count]) => ({ day, count }));
}

export interface AttemptsPerTask {
  '1': number;
  '2': number;
  '3': number;
  '4+': number;
}

function attemptsByTask(settledTaskAttempts: SettledTaskAttempt[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of settledTaskAttempts) counts.set(row.taskId, (counts.get(row.taskId) ?? 0) + 1);
  return counts;
}

/** Attempts-per-task distribution over merged Tasks, bucketed `1 / 2 / 3 / 4+`. */
export function attemptsPerTask(
  settleEvents: SettleEventRow[],
  settledTaskAttempts: SettledTaskAttempt[],
): AttemptsPerTask {
  const counts = attemptsByTask(settledTaskAttempts);
  const buckets: AttemptsPerTask = { '1': 0, '2': 0, '3': 0, '4+': 0 };
  for (const [taskId, settle] of terminalSettleByTask(settleEvents)) {
    if (settle.kind !== 'merged') continue;
    const n = counts.get(taskId) ?? 0;
    if (n <= 1) buckets['1'] += 1;
    else if (n === 2) buckets['2'] += 1;
    else if (n === 3) buckets['3'] += 1;
    else buckets['4+'] += 1;
  }
  return buckets;
}

export interface CostPerMergedTask {
  mergedTasks: number;
  mergedCost: Cost | null;
  wastedCost: Cost | null;
}

/** Merged spend and the Task count it divides by, plus the wasted spend of reverted/escalated Tasks beside it. */
export function costPerMergedTask(
  settleEvents: SettleEventRow[],
  settledTaskAttempts: SettledTaskAttempt[],
): CostPerMergedTask {
  const terminal = terminalSettleByTask(settleEvents);
  const merged = new Set<number>();
  for (const [taskId, settle] of terminal) if (settle.kind === 'merged') merged.add(taskId);

  const mergedCosts: (Cost | null)[] = [];
  const wastedCosts: (Cost | null)[] = [];
  for (const row of settledTaskAttempts) {
    if (!terminal.has(row.taskId)) continue;
    (merged.has(row.taskId) ? mergedCosts : wastedCosts).push(parseCost(row.cost));
  }
  return { mergedTasks: merged.size, mergedCost: sumCosts(mergedCosts), wastedCost: sumCosts(wastedCosts) };
}

export interface VerdictCounts {
  pass: number;
  block: number;
  inconclusive: number;
}

export interface Verdicts {
  critic: VerdictCounts;
  command: VerdictCounts;
}

/** Verification verdicts at verification-attempt grain; critic and command counted separately. `fail` is the block outcome. */
export function verdicts(verifications: VerificationRow[]): Verdicts {
  const empty = (): VerdictCounts => ({ pass: 0, block: 0, inconclusive: 0 });
  const result: Verdicts = { critic: empty(), command: empty() };
  for (const row of verifications) {
    const bucket = row.mechanism === 'critic' ? result.critic : row.mechanism === 'command' ? result.command : null;
    if (!bucket) continue;
    if (row.verdict === 'pass') bucket.pass += 1;
    else if (row.verdict === 'fail') bucket.block += 1;
    else if (row.verdict === 'inconclusive') bucket.inconclusive += 1;
  }
  return result;
}

export interface GateOutcomes {
  autoMerged: number;
  escalated: number;
  revertedOnRed: number;
}

/** How each settled Task left the merge gate, counted once per Task; a cancelled Task never reached it. */
export function gateOutcomes(settleEvents: SettleEventRow[]): GateOutcomes {
  const outcomes: GateOutcomes = { autoMerged: 0, escalated: 0, revertedOnRed: 0 };
  for (const settle of terminalSettleByTask(settleEvents).values()) {
    if (settle.kind === 'merged') outcomes.autoMerged += 1;
    else if (settle.gate === 'post-merge-red') outcomes.revertedOnRed += 1;
    else outcomes.escalated += 1;
  }
  return outcomes;
}

/** Guardrail trips keyed by dimension, once per (Attempt, dimension); a dimension that never tripped is absent. */
export function guardrailTripsByDimension(trips: GuardrailTripRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trip of trips) counts[trip.dimension] = (counts[trip.dimension] ?? 0) + 1;
  return counts;
}

/** The Attempt slice the per-Workspace breakdown needs from each in-range row. */
export interface WorkspaceAttempt {
  taskId: number;
  state: string;
  usage: string | null;
  cost: string | null;
}

export interface WorkspaceStats {
  workspaceId: number;
  name: string;
  cost: Cost | null;
  inputTokens: number;
  outputTokens: number;
  tasks: number;
  /** Failed-only rate over the Workspace's non-cancelled Attempts; null when it ran none. */
  failureRate: number | null;
}

function inputOutput(usages: AttemptUsage[]): { inputTokens: number; outputTokens: number } {
  const merged = mergeUsage(usages);
  if (!merged) return { inputTokens: 0, outputTokens: 0 };
  if (merged.totals) return { inputTokens: merged.totals.inputTokens, outputTokens: merged.totals.outputTokens };
  return Object.values(merged.models).reduce(
    (sum, m) => ({ inputTokens: sum.inputTokens + m.inputTokens, outputTokens: sum.outputTokens + m.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/** The attempt-grain aggregates grouped by owning Workspace, ordered by cost. */
export function byWorkspace(
  rows: WorkspaceAttempt[],
  taskWorkspaces: TaskWorkspaceRow[],
  workspaces: WorkspaceNameRow[],
): WorkspaceStats[] {
  const workspaceOfTask = new Map(taskWorkspaces.map((t) => [t.taskId, t.workspaceId]));
  const nameOf = new Map(workspaces.map((w) => [w.id, w.name]));

  const grouped = new Map<number, WorkspaceAttempt[]>();
  for (const row of rows) {
    const workspaceId = workspaceOfTask.get(row.taskId);
    if (workspaceId == null) continue;
    const bucket = grouped.get(workspaceId);
    if (bucket) bucket.push(row);
    else grouped.set(workspaceId, [row]);
  }

  const stats: WorkspaceStats[] = [];
  for (const [workspaceId, group] of grouped) {
    const usages = group
      .map((r) => (r.usage ? (JSON.parse(r.usage) as AttemptUsage) : null))
      .filter((u): u is AttemptUsage => u !== null);
    const { inputTokens, outputTokens } = inputOutput(usages);
    const nonCancelled = group.filter((r) => r.state !== 'cancelled').length;
    const failed = group.filter((r) => isExecutionFailure({ state: r.state })).length;
    stats.push({
      workspaceId,
      name: nameOf.get(workspaceId) ?? `workspace ${workspaceId}`,
      cost: sumCosts(group.map((r) => parseCost(r.cost))),
      inputTokens,
      outputTokens,
      tasks: new Set(group.map((r) => r.taskId)).size,
      failureRate: nonCancelled === 0 ? null : failed / nonCancelled,
    });
  }

  return stats.sort((a, b) => (b.cost?.totalUsd ?? 0) - (a.cost?.totalUsd ?? 0) || a.workspaceId - b.workspaceId);
}
