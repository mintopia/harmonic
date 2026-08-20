import { existsSync } from 'node:fs';
import type { HarnessConfig } from '../config.js';
import type { PersistedRunEvent } from '../domain/runs.js';
import { isReplay } from '../domain/replay-quarantine.js';
import { adapterFor, type ModelUsage } from './harness/adapter.js';

export type { ModelUsage };

export interface RunUsage {
  /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
  models: Record<string, ModelUsage>;
  /**
   * Per-agent-type breakdown (agent-usage / subagent-share stats): each
   * Process Tree node's own tokens folded under its name (`root` for the
   * root session, the agentType for a Subagent). Absent for harnesses/runs
   * with no parsed tree, and on runs recorded before the field existed —
   * the Stats aggregation treats a missing map as "no per-agent data".
   */
  agents?: Record<string, ModelUsage>;
  /** Aggregate token counts; null when no source reported tokens. */
  totals: (ModelUsage & { totalTokens: number | null }) | null;
  /** Tool-call tallies from the run's events. */
  toolCalls: Record<string, number>;
  source: 'acp' | 'session-log' | 'combined' | null;
}

/** The reserved agent name for the root session in a per-agent breakdown —
 * everything else is a Subagent, so `subagent share = 1 − root/total`. */
export const ROOT_AGENT = 'root';

/** Live status of a Process Tree node — idle age drives active → inactive → hidden. */
export type ProcessStatus = 'active' | 'inactive' | 'hidden';

/**
 * One process in a Process Tree (CONTEXT.md): the root Run/Conversation
 * session or a recursive Subagent. `usage` is the node's *own* tokens;
 * roll-ups (`rollUpUsage`) sum the whole subtree. Derived per-Harness at
 * read time, never stored as a structure.
 */
export interface ProcessNode {
  /** Harness session/subagent id (root: the run's sessionId). */
  id: string;
  /** Subagent agentType, or a label for the root process. */
  name: string;
  /** Model serving this node's calls (the price bucket in a roll-up). */
  model: string;
  /** This node's own token usage, excluding its children. */
  usage: ModelUsage;
  /** Latest context-window fill for this node, or null when unknown. */
  contextTokens: number | null;
  status: ProcessStatus;
  /** 0 for the root; +1 per Subagent nesting level. */
  depth: number;
  /** For a Subagent, the spawning `Agent`/`Task` tool-use id — the key the
   * Activity drill-in frames its transcript on (issue #53); null for the root. */
  toolUseId: string | null;
  children: ProcessNode[];
}

/** A root process and its recursive Subagents (CONTEXT.md: Process Tree). */
export type ProcessTree = ProcessNode;

/**
 * The live snapshot a session's tailer pushes (ADR 0010): rolled-up Usage,
 * the root's context-window fill, the current-activity line, and the whole
 * Process Tree. Cost is derived on read (never stored), so it isn't here —
 * the firehose adds it at serialize time.
 */
export interface RunUsageSnapshot {
  usage: RunUsage;
  /** The root session's latest context-window fill; null when unknown. */
  contextTokens: number | null;
  /** One-line "what the agent is doing now", from the latest event; null before any. */
  activity: string | null;
  tree: ProcessTree;
}

/**
 * A one-line current-activity label from an ACP `session/update` — the
 * latest tool call's title or the latest assistant message text. Returns
 * null for updates that aren't activity (thoughts, plans), so the caller
 * keeps the previous line rather than blanking it.
 */
const ACTIVITY_MAX = 120;
export function activityLine(update: unknown): string | null {
  const u = update as any;
  switch (u?.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const title = u.title ?? u.kind;
      return typeof title === 'string' && title ? title.slice(0, ACTIVITY_MAX) : null;
    }
    case 'agent_message_chunk': {
      const text = u.content?.type === 'text' ? u.content.text : null;
      const line = typeof text === 'string' ? text.split('\n').find((l: string) => l.trim())?.trim() : null;
      return line ? line.slice(0, ACTIVITY_MAX) : null;
    }
    default:
      return null;
  }
}

/** A Usage Collector's parse of one session: rolled-up Usage + its Process Tree. */
export interface ParsedSession {
  /**
   * Usage rolled up across the whole tree (parent + every Subagent).
   * Collectors keep the true per-model split (`usageFromModels`) rather
   * than `rollUpUsage`'s dominant-model-per-node collapse, so a
   * multi-model node (Copilot's `auto` router) prices exactly.
   */
  usage: RunUsage;
  tree: ProcessTree;
}

/**
 * Roll a Process Tree's per-node Usage up into one RunUsage, summing each
 * node's tokens into its model's bucket so a parent's total includes its
 * whole tree (CONTEXT.md → Usage). Keeping the per-model split means
 * `costOfUsages` prices the roll-up and flags `incomplete` for any
 * unpriced model in the tree — never a fake zero.
 */
export function rollUpUsage(tree: ProcessTree): RunUsage {
  const flatten = (node: ProcessNode): RunUsage[] => [
    { models: { [node.model]: node.usage }, totals: null, toolCalls: {}, source: null },
    ...node.children.flatMap(flatten),
  ];
  const merged = mergeUsage(flatten(tree))!;
  // Native logs are the source (ADR 0009); mergeUsage leaves source null.
  return { ...merged, totals: sumModels(merged.models), source: 'session-log' };
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
  const acpTotals = totalsFromAcp(input.promptResult?.usage);
  // The harness parser rolls Subagents into the per-model split (the
  // undercount fix, #48) and yields the Process Tree the per-agent
  // breakdown is folded from. Parsed once, reused for models and agents.
  const parsed = collector?.parse?.({
    sessionLogDir: input.harness.sessionLogDir,
    cwd: input.cwd,
    sessionId: input.sessionId,
  });

  // Prompt-result breakdown first (codex); the parsed tree's rolled-up
  // per-model split next (claude/copilot — this is where a Subagent's model,
  // e.g. a Sonnet helper, now shows up instead of being dropped); the raw
  // session-log reader (parent only) as the last resort.
  let models =
    input.promptResult && collector?.modelsFromPromptResult
      ? collector.modelsFromPromptResult(input.promptResult)
      : {};
  if (Object.keys(models).length === 0) {
    if (parsed && Object.keys(parsed.usage.models).length > 0) {
      models = parsed.usage.models;
    } else {
      const file = sessionLogFile(input);
      models = collector && file ? collector.modelsFromSessionLog(file, input.sessionId) : {};
    }
  }
  const agents = parsed ? agentsFromTree(parsed.tree) : undefined;
  const toolCalls = tallyToolCalls(input.events, (payload) => collector?.toolName(payload) ?? null);

  if (!acpTotals && Object.keys(models).length === 0) return null;
  return {
    models,
    ...(agents && Object.keys(agents).length > 0 ? { agents } : {}),
    totals: acpTotals ?? sumModels(models),
    toolCalls,
    source: acpTotals && Object.keys(models).length > 0 ? 'combined' : acpTotals ? 'acp' : 'session-log',
  };
}

/**
 * Fold a Process Tree into a per-agent-type breakdown: each node's *own*
 * tokens summed under its name (`root` for the root, the agentType for a
 * Subagent), so N agents of the same type roll into one bucket. The source
 * for the Stats agent-usage chart and the subagent-share figure.
 */
export function agentsFromTree(tree: ProcessNode): Record<string, ModelUsage> {
  const agents: Record<string, ModelUsage> = {};
  const walk = (node: ProcessNode): void => {
    const bucket = (agents[node.name] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    bucket.inputTokens += node.usage.inputTokens;
    bucket.outputTokens += node.usage.outputTokens;
    bucket.cacheReadTokens += node.usage.cacheReadTokens;
    bucket.cacheWriteTokens += node.usage.cacheWriteTokens;
    if (node.usage.aiUnits !== undefined) bucket.aiUnits = (bucket.aiUnits ?? 0) + node.usage.aiUnits;
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return agents;
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

export function tallyToolCalls(
  events: PersistedRunEvent[],
  preferredName: (payload: unknown) => string | null,
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'session_update') continue;
    // Load-time replay (`session/load`) re-emits historical tool calls before
    // the current turn; counting them would attribute a whole prior conversation
    // to this turn (issue #144 AC2). Exclude replayed events from the tally.
    if (isReplay(event)) continue;
    const payload = event.payload as any;
    if (payload?.sessionUpdate !== 'tool_call') continue;
    const name = preferredName(payload) ?? payload?.title ?? payload?.kind ?? 'unknown';
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

/** Wrap a per-model breakdown as a session-log-sourced RunUsage (ADR 0009). */
export function usageFromModels(models: Record<string, ModelUsage>): RunUsage {
  return { models, totals: sumModels(models), toolCalls: {}, source: 'session-log' };
}

/**
 * Sum a per-model breakdown into one ModelUsage — a single Process Tree
 * node's own tokens, all its models folded together. AI Units total only
 * when some model reported them; never a fake zero.
 */
export function foldModels(models: Record<string, ModelUsage>): ModelUsage {
  const total: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const u of Object.values(models)) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheReadTokens += u.cacheReadTokens;
    total.cacheWriteTokens += u.cacheWriteTokens;
    if (u.aiUnits !== undefined) total.aiUnits = (total.aiUnits ?? 0) + u.aiUnits;
  }
  return total;
}

/**
 * The model owning the most tokens — the price bucket for a single
 * Process Tree node whose calls span several models (Codex resume,
 * Copilot's `auto` router). null for an empty breakdown.
 */
export function dominantModel(models: Record<string, ModelUsage>): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, u] of Object.entries(models)) {
    const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    if (tokens > bestTokens) {
      best = model;
      bestTokens = tokens;
    }
  }
  return best;
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
 * The cumulative token count for a run's Usage, the way a live spend guard
 * reads it (issue #128): the reported aggregate `totals.totalTokens` when a
 * source provided one, else the sum of the four token classes across the
 * per-model split, else `null` — no telemetry at all, which the spend
 * Guardrail treats as unmeasurable rather than as zero.
 */
export function totalTokensOf(usage: RunUsage): number | null {
  if (typeof usage.totals?.totalTokens === 'number') return usage.totals.totalTokens;
  const models = Object.values(usage.models);
  if (models.length === 0) return null;
  return models.reduce(
    (sum, mu) => sum + mu.inputTokens + mu.outputTokens + mu.cacheReadTokens + mu.cacheWriteTokens,
    0,
  );
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
    if (usage.agents) {
      const agents = (merged.agents ??= {});
      for (const [name, au] of Object.entries(usage.agents)) {
        const bucket = (agents[name] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
        bucket.inputTokens += au.inputTokens;
        bucket.outputTokens += au.outputTokens;
        bucket.cacheReadTokens += au.cacheReadTokens;
        bucket.cacheWriteTokens += au.cacheWriteTokens;
        if (au.aiUnits !== undefined) bucket.aiUnits = (bucket.aiUnits ?? 0) + au.aiUnits;
      }
    }
  }
  merged.totals = totals;
  return merged;
}
