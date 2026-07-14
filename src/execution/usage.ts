import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessConfig } from '../config.js';
import type { PersistedRunEvent } from '../domain/runs.js';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

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
  promptResult?: { usage?: Record<string, unknown> } | undefined;
  events: PersistedRunEvent[];
}

/**
 * Per-harness usage collection, per ADR-0001: ACP `usage` on the prompt
 * result first (aggregate, always cheap), the harness's native session
 * log for the per-model breakdown when available. Returns null when no
 * source reported any tokens — "unavailable", never a fake zero.
 */
export function collectUsage(input: CollectUsageInput): RunUsage | null {
  const totals = totalsFromAcp(input.promptResult?.usage);
  const models = modelsFromSessionLog(input);
  const toolCalls = tallyToolCalls(input.events);

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

/**
 * Claude Code writes `<sessionLogDir>/<slug(cwd)>/<sessionId>.jsonl` where
 * the slug replaces every non-alphanumeric character with '-', and the
 * ACP sessionId equals the log filename (spike finding). Each assistant
 * message line carries `message.model` + `message.usage`; chunked
 * messages repeat the same message id, so dedupe on it.
 */
function modelsFromSessionLog(input: CollectUsageInput): Record<string, ModelUsage> {
  const logDir = input.harness.sessionLogDir ?? defaultSessionLogDir(input.harnessId);
  if (!logDir || !input.sessionId) return {};
  const slug = input.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const file = join(logDir, slug, `${input.sessionId}.jsonl`);
  if (!existsSync(file)) return {};

  const models: Record<string, ModelUsage> = {};
  const seen = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== 'assistant' || !message?.model || !message?.usage) continue;
    const key = typeof message.id === 'string' ? message.id : line;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = (models[message.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    bucket.inputTokens += num(message.usage.input_tokens);
    bucket.outputTokens += num(message.usage.output_tokens);
    bucket.cacheReadTokens += num(message.usage.cache_read_input_tokens);
    bucket.cacheWriteTokens += num(message.usage.cache_creation_input_tokens);
  }
  return models;
}

function defaultSessionLogDir(harnessId: string): string | null {
  return harnessId === 'claude' ? join(homedir(), '.claude', 'projects') : null;
}

function tallyToolCalls(events: PersistedRunEvent[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'session_update') continue;
    const payload = event.payload as any;
    if (payload?.sessionUpdate !== 'tool_call') continue;
    const name = payload?._meta?.claudeCode?.toolName ?? payload?.title ?? payload?.kind ?? 'unknown';
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

function sumModels(models: Record<string, ModelUsage>): RunUsage['totals'] {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of Object.values(models)) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return { ...totals, totalTokens: null };
}

/** Merge run usages into one aggregate (task rollups, stats ranges). */
export function mergeUsage(usages: RunUsage[]): RunUsage | null {
  if (usages.length === 0) return null;
  const merged: RunUsage = { models: {}, totals: null, toolCalls: {}, source: null };
  let totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number | null } | null = null;
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
    }
    for (const [tool, count] of Object.entries(usage.toolCalls)) {
      merged.toolCalls[tool] = (merged.toolCalls[tool] ?? 0) + count;
    }
  }
  merged.totals = totals;
  return merged;
}
