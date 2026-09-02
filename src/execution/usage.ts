import { existsSync } from 'node:fs';
import type { HarnessConfig } from '../config.js';
import type { PersistedAttemptEvent } from '../domain/attempts.js';
import { isReplay } from '../domain/replay-quarantine.js';
import type { ModelUsage, AttemptUsage, ToolTokenUsage } from '../domain/usage.js';
import { DEFAULT_PRICES, turnCost, type PriceTable } from '../domain/pricing.js';
import { adapterFor } from './harness/registry.js';

export type { ModelUsage, AttemptUsage, ToolTokenUsage };

/** One parsed model turn, including every tool call it made. */
export interface UsageTurn {
  model: string;
  usage: ModelUsage;
  tools: string[];
}

/** The reserved agent name for the root session in a per-agent breakdown —
 * everything else is a Subagent, so `subagent share = 1 − root/total`. */
export const ROOT_AGENT = 'root';

/** Live status of a Process Tree node — idle age drives active → inactive → hidden. */
export type ProcessStatus = 'active' | 'inactive' | 'hidden';

/**
 * One process in a Process Tree: the root Attempt/Conversation session or a
 * recursive Subagent. `usage` is the node's *own* tokens; roll-ups
 * (`rollUpUsage`) sum the whole subtree.
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
  /** For a Subagent, the spawning `Agent`/`Task` tool-use id; null for the root. */
  toolUseId: string | null;
  children: ProcessNode[];
}

/** A root process and its recursive Subagents. */
export type ProcessTree = ProcessNode;

/**
 * The live snapshot a session's tailer pushes: rolled-up Usage, the root's
 * context-window fill, the current-activity line, and the whole Process
 * Tree. Cost is derived on read (never stored), so it isn't here.
 */
export interface AttemptUsageSnapshot {
  usage: AttemptUsage;
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
  /** Usage rolled up across the whole tree (parent + every Subagent). */
  usage: AttemptUsage;
  tree: ProcessTree;
  /** Present only for harnesses whose native transcript exposes turn boundaries
   * and tool calls, the evidence required for honest tool attribution. */
  turns?: UsageTurn[];
}

/**
 * Roll a Process Tree's per-node Usage up into one AttemptUsage, summing each
 * node's tokens into its model's bucket so a parent's total includes its
 * whole tree. Keeping the per-model split means `costOfUsages` prices the
 * roll-up and flags `incomplete` for any unpriced model in the tree.
 */
export function rollUpUsage(tree: ProcessTree): AttemptUsage {
  const flatten = (node: ProcessNode): AttemptUsage[] => [
    { models: { [node.model]: node.usage }, totals: null, toolCalls: {}, source: null },
    ...node.children.flatMap(flatten),
  ];
  const merged = mergeUsage(flatten(tree))!;
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
  /** Conversation-only ACP events, retained while Conversations still persist their transcript. */
  events?: PersistedAttemptEvent[] | undefined;
  /** Effective per-model prices at collection time, used to freeze the
   * API-equivalent output cost alongside token attribution. */
  prices?: PriceTable | undefined;
}

/**
 * Per-harness usage collection: ACP `usage` on the prompt result first
 * (aggregate, always cheap), the harness's Usage Collector for the per-model
 * breakdown when available. Returns null when no source reported any tokens —
 * "unavailable", never a fake zero.
 */
export function collectUsage(input: CollectUsageInput): AttemptUsage | null {
  const collector = adapterFor(input.harnessId).usage;
  const acpTotals = totalsFromAcp(input.promptResult?.usage);
  const parsed = collector?.parse?.({
    sessionLogDir: input.harness.sessionLogDir,
    cwd: input.cwd,
    sessionId: input.sessionId,
  });

  const hasSubagents = (parsed?.tree.children.length ?? 0) > 0;
  let models =
    !hasSubagents && input.promptResult && collector?.modelsFromPromptResult
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
  const attribution = parsed?.turns ? attributeTurnTokens(parsed.turns, input.prices) : undefined;
  const toolCalls = tallyToolCalls(input.events ?? [], (payload) => collector?.toolName(payload) ?? null);

  if (!acpTotals && Object.keys(models).length === 0) return null;
  // ACP's prompt-result `usage` sums input+cache across every internal round-trip
  // of an agentic turn, so it over-counts window occupancy on multi-tool turns.
  const contextTokens = parsed?.tree.contextTokens ?? contextInputTokens(input.promptResult?.usage);
  return {
    models,
    ...(agents && Object.keys(agents).length > 0 ? { agents } : {}),
    ...(attribution ?? {}),
    totals: hasSubagents ? sumModels(models) : acpTotals ?? sumModels(models),
    toolCalls,
    ...(contextTokens !== null ? { contextTokens } : {}),
    source: acpTotals && Object.keys(models).length > 0 ? 'combined' : acpTotals ? 'acp' : 'session-log',
  };
}

/**
 * Attribute a parsed turn's output tokens across its tool calls. Calls divide
 * by count (not distinct name), then fold under a name; the final call absorbs
 * the remainder so integer token totals reconcile exactly. A no-tool turn is
 * reasoning rather than fabricated tool usage.
 */
export function attributeTurnTokens(
  turns: UsageTurn[],
  prices: PriceTable = DEFAULT_PRICES,
): Pick<AttemptUsage, 'toolTokens' | 'reasoning'> {
  const toolTokens: Record<string, ToolTokenUsage> = {};
  let reasoning: ToolTokenUsage | undefined;
  const unpriced = new Set<ToolTokenUsage>();

  const add = (target: ToolTokenUsage, outputTokens: number, cost: number | undefined): void => {
    target.outputTokens += outputTokens;
    if (cost === undefined) {
      delete target.cost;
      unpriced.add(target);
    } else if (!unpriced.has(target)) {
      target.cost = (target.cost ?? 0) + cost;
    }
  };

  for (const turn of turns) {
    const outputTokens = turn.usage.outputTokens;
    if (outputTokens === 0) continue;
    const cost = turnCost(turn.model, turn.usage, prices);
    if (turn.tools.length === 0) {
      reasoning ??= { outputTokens: 0 };
      add(reasoning, outputTokens, cost);
      continue;
    }

    const share = Math.floor(outputTokens / turn.tools.length);
    const costShare = cost === undefined ? undefined : cost / turn.tools.length;
    let outputAssigned = 0;
    let costAssigned = 0;
    for (const [index, tool] of turn.tools.entries()) {
      const tokens = index === turn.tools.length - 1 ? outputTokens - outputAssigned : share;
      const toolCost =
        cost === undefined ? undefined : index === turn.tools.length - 1 ? cost - costAssigned : costShare;
      const bucket = (toolTokens[tool] ??= { outputTokens: 0 });
      add(bucket, tokens, toolCost);
      outputAssigned += tokens;
      costAssigned += toolCost ?? 0;
    }
  }

  return {
    ...(Object.keys(toolTokens).length > 0 ? { toolTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
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

function totalsFromAcp(usage: Record<string, unknown> | undefined): AttemptUsage['totals'] | null {
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
  events: PersistedAttemptEvent[],
  preferredName: (payload: unknown) => string | null,
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'session_update') continue;
    if (isReplay(event)) continue;
    const payload = event.payload;
    if (!isToolCall(payload)) continue;
    const name = toolCallName(payload, preferredName);
    tally[name] = (tally[name] ?? 0) + 1;
  }
  return tally;
}

function isToolCall(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && payload.sessionUpdate === 'tool_call';
}

// ACP puts unbounded per-call detail (the shell command, the file path, the
// search query, the URL) in the tool-call title, so these kinds map to a stable name.
const KIND_TOOL: Record<string, string> = {
  execute: 'Bash',
  read: 'Read',
  search: 'Grep',
  fetch: 'WebFetch',
  delete: 'Bash',
  move: 'Bash',
};

/** The stable stats label for an ACP tool-call update. */
export function toolCallName(payload: unknown, preferredName: (payload: unknown) => string | null): string {
  const update = isRecord(payload) ? payload : null;
  const kind = typeof update?.kind === 'string' ? update.kind : null;
  const title = typeof update?.title === 'string' ? update.title : null;
  return preferredName(payload) ?? (kind && KIND_TOOL[kind]) ?? title ?? kind ?? 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Wrap a per-model breakdown as a session-log-sourced AttemptUsage. */
export function usageFromModels(models: Record<string, ModelUsage>): AttemptUsage {
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

function sumModels(models: Record<string, ModelUsage>): AttemptUsage['totals'] {
  const totals: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of Object.values(models)) {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.aiUnits !== undefined) totals.aiUnits = (totals.aiUnits ?? 0) + usage.aiUnits;
  }
  return { ...totals, totalTokens: null };
}

/**
 * The cumulative token count for a run's Usage, the way a live spend guard
 * reads it: the reported aggregate `totals.totalTokens` when a source
 * provided one, else the sum of the four token classes across the per-model
 * split, else `null` — no telemetry at all, which the spend Guardrail treats
 * as unmeasurable rather than as zero.
 */
export function totalTokensOf(usage: AttemptUsage): number | null {
  if (typeof usage.totals?.totalTokens === 'number') return usage.totals.totalTokens;
  const models = Object.values(usage.models);
  if (models.length === 0) return null;
  return models.reduce(
    (sum, mu) => sum + mu.inputTokens + mu.outputTokens + mu.cacheReadTokens + mu.cacheWriteTokens,
    0,
  );
}

/**
 * Attempt-end collection races the harness's final session-log flush: the
 * log file exists from session start, but the last assistant usage
 * lines can merge milliseconds after the prompt result. When the file
 * exists and yields no per-model split yet, re-read briefly before
 * settling for aggregate totals. No file at all means no log is coming
 * (stub harnesses) — return immediately.
 */
export async function collectUsageWithRetry(
  input: CollectUsageInput,
  retry: { timeoutMs: number; intervalMs: number } = { timeoutMs: 2000, intervalMs: 100 },
): Promise<AttemptUsage | null> {
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
 * fill. null when the result reported no usage.
 */
export function contextInputTokens(usage: Record<string, unknown> | undefined): number | null {
  const totals = totalsFromAcp(usage);
  if (!totals) return null;
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/**
 * Fold a Turn's freshly-collected Usage into a Conversation's running total.
 * A per-model source (the harness session log) is *cumulative* for the warm
 * session, so it replaces; an ACP-aggregate-only Turn is *per-Turn*, so its
 * totals accumulate. Tool-call tallies are always taken from the full event
 * stream, so they replace.
 */
export function accumulateUsage(stored: AttemptUsage | null, turn: AttemptUsage | null): AttemptUsage | null {
  if (!turn) return stored;
  if (Object.keys(turn.models).length > 0) return turn;
  if (!stored) return turn;
  return {
    models: {},
    totals: addTotals(stored.totals, turn.totals),
    toolCalls: turn.toolCalls,
    source: 'acp',
  };
}

function addTotals(a: AttemptUsage['totals'], b: AttemptUsage['totals']): AttemptUsage['totals'] {
  if (!a) return b;
  if (!b) return a;
  const sum = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens !== null && b.totalTokens !== null ? a.totalTokens + b.totalTokens : null,
  } as AttemptUsage['totals'] & { totalTokens: number | null };
  if (a.aiUnits !== undefined || b.aiUnits !== undefined) {
    sum.aiUnits = (a.aiUnits ?? 0) + (b.aiUnits ?? 0);
  }
  return sum;
}

/** Merge run usages into one aggregate (task rollups, stats ranges). */
export function mergeUsage(usages: AttemptUsage[]): AttemptUsage | null {
  if (usages.length === 0) return null;
  const merged: AttemptUsage = { models: {}, totals: null, toolCalls: {}, source: null };
  let totals: AttemptUsage['totals'] = null;
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
    if (usage.toolTokens) {
      const toolTokens = (merged.toolTokens ??= {});
      for (const [tool, attribution] of Object.entries(usage.toolTokens)) {
        const bucket = toolTokens[tool];
        if (!bucket) {
          toolTokens[tool] = { ...attribution };
          continue;
        }
        bucket.outputTokens += attribution.outputTokens;
        if (bucket.cost !== undefined && attribution.cost !== undefined) bucket.cost += attribution.cost;
        else if (attribution.cost === undefined) delete bucket.cost;
      }
    }
    if (usage.reasoning) {
      if (!merged.reasoning) {
        merged.reasoning = { ...usage.reasoning };
        continue;
      }
      const reasoning = merged.reasoning;
      reasoning.outputTokens += usage.reasoning.outputTokens;
      if (reasoning.cost !== undefined && usage.reasoning.cost !== undefined) reasoning.cost += usage.reasoning.cost;
      else if (usage.reasoning.cost === undefined) delete reasoning.cost;
    }
  }
  merged.totals = totals;
  return merged;
}
