import { existsSync } from 'node:fs';
import type { HarnessConfig } from '../config.js';
import type { PersistedRunEvent } from '../domain/runs.js';
import { adapterFor, type ModelUsage } from './harness/adapter.js';

export type { ModelUsage };

export interface RunUsage {
  /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
  models: Record<string, ModelUsage>;
  /** Aggregate token counts; null when no source reported tokens. */
  totals: (ModelUsage & { totalTokens: number | null }) | null;
  /** Tool-call tallies from the run's events. */
  toolCalls: Record<string, number>;
  source: 'acp' | 'session-log' | 'combined' | null;
}

export interface CollectUsageInput {
  harnessId: string;
  harness: HarnessConfig;
  /** The directory the run actually executed in (worktree path in worktree mode). */
  cwd: string;
  sessionId: string | null;
  /** The ACP session/prompt result, when the run finished cleanly. */
  promptResult?: { usage?: Record<string, unknown>; _meta?: unknown } | undefined;
  events: PersistedRunEvent[];
}

/**
 * Per-harness usage collection, per ADR-0001: ACP `usage` on the prompt
 * result first (aggregate, always cheap), the harness's Usage Collector
 * (harness/adapter.ts) for the per-model breakdown when available.
 * Returns null when no source reported any tokens — "unavailable",
 * never a fake zero.
 */
export function collectUsage(input: CollectUsageInput): RunUsage | null {
  const collector = adapterFor(input.harnessId).usage;
  const totals = totalsFromAcp(input.promptResult?.usage);
  // Prompt-result breakdown first (codex); session log as the fallback.
  let models =
    input.promptResult && collector?.modelsFromPromptResult
      ? collector.modelsFromPromptResult(input.promptResult)
      : {};
  if (Object.keys(models).length === 0) {
    const file = sessionLogFile(input);
    models = collector && file ? collector.modelsFromSessionLog(file, input.sessionId) : {};
  }
  const toolCalls = tallyToolCalls(input.events, (payload) => collector?.toolName(payload) ?? null);

  if (!totals && Object.keys(models).length === 0) return null;
  return {
    models,
    totals: totals ?? sumModels(models),
    toolCalls,
    source: totals && Object.keys(models).length > 0 ? 'combined' : totals ? 'acp' : 'session-log',
  };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function totalsFromAcp(usage: Record<string, unknown> | undefined): RunUsage['totals'] | null {
  if (!usage) return null;
  return {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cachedReadTokens ?? usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cachedWriteTokens ?? usage.cacheWriteTokens),
    totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
  };
}

function sessionLogFile(input: CollectUsageInput): string | null {
  const collector = adapterFor(input.harnessId).usage;
  if (!collector) return null;
  return collector.sessionLogFile({
    sessionLogDir: input.harness.sessionLogDir,
    cwd: input.cwd,
    sessionId: input.sessionId,
  });
}

function tallyToolCalls(
  events: PersistedRunEvent[],
  preferredName: (payload: unknown) => string | null,
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'session_update') continue;
    const payload = event.payload as any;
    if (payload?.sessionUpdate !== 'tool_call') continue;
    const name = preferredName(payload) ?? payload?.title ?? payload?.kind ?? 'unknown';
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

function sumModels(models: Record<string, ModelUsage>): RunUsage['totals'] {
  const totals: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of Object.values(models)) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    // AI Units total only when some model reported them — never a fake zero.
    if (usage.aiUnits !== undefined) totals.aiUnits = (totals.aiUnits ?? 0) + usage.aiUnits;
  }
  return { ...totals, totalTokens: null };
}

/**
 * Run-end collection races the harness's final session-log flush: the
 * log file exists from session start, but the last assistant usage
 * lines can land milliseconds after the prompt result. When the file
 * exists and yields no per-model split yet, re-read briefly before
 * settling for aggregate totals. No file at all means no log is coming
 * (stub harnesses) — return immediately.
 */
export async function collectUsageWithRetry(
  input: CollectUsageInput,
  retry: { timeoutMs: number; intervalMs: number } = { timeoutMs: 2000, intervalMs: 100 },
): Promise<RunUsage | null> {
  const deadline = Date.now() + retry.timeoutMs;
  for (;;) {
    const usage = collectUsage(input);
    if (usage && Object.keys(usage.models).length > 0) return usage;
    const file = sessionLogFile(input);
    if (!file || !existsSync(file) || Date.now() >= deadline) return usage;
    await new Promise((r) => setTimeout(r, retry.intervalMs));
  }
}

/**
 * The observed models contradicting the task's pinned model, or null when
 * the pin demonstrably held (or nothing was observed). Ids are compared on
 * their base form: codex effort suffixes (`gpt-5.4-mini[low]`) and dated
 * session-log ids (`claude-haiku-4-5-20251001`) both count as their base
 * model. A contradiction means NO observed model matches — harnesses
 * legitimately spend side tokens on helper models (Claude subagents), and
 * that is not a broken pin. A task pinned to `auto` delegated the choice
 * (Copilot's router): whatever served is the answer, not a contradiction.
 */
export function observedModelMismatch(expected: string, models: Record<string, ModelUsage>): string[] | null {
  if (expected === 'auto') return null;
  const base = (id: string) => id.replace(/\[[^\]]+\]$/, '').replace(/-\d{8}$/, '');
  const observed = Object.keys(models);
  if (observed.length === 0) return null;
  return observed.some((id) => base(id) === base(expected)) ? null : observed;
}

/**
 * The latest Turn's input-side token footprint — inputs plus cache reads and
 * writes — from an ACP prompt result, for a Conversation's context-window
 * fill (issue 12). null when the result reported no usage.
 */
export function contextInputTokens(usage: Record<string, unknown> | undefined): number | null {
  const totals = totalsFromAcp(usage);
  if (!totals) return null;
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/**
 * Fold a Turn's freshly-collected Usage into a Conversation's running total
 * (issue 12). A per-model source (the harness session log) is *cumulative*
 * for the warm session, so it replaces; an ACP-aggregate-only Turn is
 * *per-Turn*, so its totals accumulate. Tool-call tallies are always taken
 * from the full event stream, so they replace.
 */
export function accumulateUsage(stored: RunUsage | null, turn: RunUsage | null): RunUsage | null {
  if (!turn) return stored;
  // Cumulative per-model source (session log): everything is session-to-date.
  if (Object.keys(turn.models).length > 0) return turn;
  if (!stored) return turn;
  return {
    models: {},
    totals: addTotals(stored.totals, turn.totals),
    toolCalls: turn.toolCalls,
    source: 'acp',
  };
}

function addTotals(a: RunUsage['totals'], b: RunUsage['totals']): RunUsage['totals'] {
  if (!a) return b;
  if (!b) return a;
  const sum = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens !== null && b.totalTokens !== null ? a.totalTokens + b.totalTokens : null,
  } as RunUsage['totals'] & { totalTokens: number | null };
  if (a.aiUnits !== undefined || b.aiUnits !== undefined) {
    sum.aiUnits = (a.aiUnits ?? 0) + (b.aiUnits ?? 0);
  }
  return sum;
}

/** Merge run usages into one aggregate (task rollups, stats ranges). */
export function mergeUsage(usages: RunUsage[]): RunUsage | null {
  if (usages.length === 0) return null;
  const merged: RunUsage = { models: {}, totals: null, toolCalls: {}, source: null };
  let totals: RunUsage['totals'] = null;
  for (const usage of usages) {
    for (const [model, mu] of Object.entries(usage.models)) {
      const bucket = (merged.models[model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      bucket.inputTokens += mu.inputTokens;
      bucket.outputTokens += mu.outputTokens;
      bucket.cacheReadTokens += mu.cacheReadTokens;
      bucket.cacheWriteTokens += mu.cacheWriteTokens;
      if (mu.aiUnits !== undefined) bucket.aiUnits = (bucket.aiUnits ?? 0) + mu.aiUnits;
    }
    if (usage.totals) {
      totals ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
      totals.inputTokens += usage.totals.inputTokens;
      totals.outputTokens += usage.totals.outputTokens;
      totals.cacheReadTokens += usage.totals.cacheReadTokens;
      totals.cacheWriteTokens += usage.totals.cacheWriteTokens;
      totals.totalTokens =
        usage.totals.totalTokens === null || totals.totalTokens === null
          ? null
          : totals.totalTokens + usage.totals.totalTokens;
      if (usage.totals.aiUnits !== undefined) totals.aiUnits = (totals.aiUnits ?? 0) + usage.totals.aiUnits;
    }
    for (const [tool, count] of Object.entries(usage.toolCalls)) {
      merged.toolCalls[tool] = (merged.toolCalls[tool] ?? 0) + count;
    }
  }
  merged.totals = totals;
  return merged;
}
