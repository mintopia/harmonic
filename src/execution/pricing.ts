import type { ModelUsage, RunUsage } from './usage.js';

/** Per-model API rates in $/Mtok — the four counters `RunUsage.models` stores. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Cost (see CONTEXT.md): the dollar value of Usage, derived on read.
 * A model without a price contributes null, and the whole aggregate is
 * flagged incomplete — a partial total is a floor, never a fake zero.
 */
export interface Cost {
  /** Sum over priced models; null when nothing could be priced. */
  totalUsd: number | null;
  /** $ per model; null for models without a price entry. */
  byModel: Record<string, number | null>;
  /** True when any tokens in the aggregate could not be priced. */
  incomplete: boolean;
}

/**
 * Shipped defaults for the models the supported Harnesses actually use
 * (see `defaultConfig()`), at published API rates. Config `prices`
 * entries override or extend these — see `resolvePrices`.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // OpenAI rates as published 2026-07 (developers.openai.com/api/docs/pricing).
  // Only the gpt-5.6 family bills explicit cache writes (1.25× input).
  'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5.6-terra': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  'gpt-5.6-luna': { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  'gpt-5.2': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.2-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5.2-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  // Copilot serves models under its own dotted ids (spike, issue 25);
  // Cost stays API-equivalent per observed serving model (decision Q4).
  // Anthropic rates match the dashed entries above per family.
  'claude-sonnet-4.6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4.5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4.5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4.8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4.7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4.6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4.5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Observed from copilot's auto router (spike Q3); OpenAI published rate.
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  // Codex-family models share their generation's codex rate (cf. gpt-5.2-codex).
  'gpt-5.3-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

/** Effective price table: shipped defaults with config overrides on top. */
export function resolvePrices(overrides: PriceTable): PriceTable {
  return { ...DEFAULT_PRICES, ...overrides };
}

/** Session logs use dated ids (claude-haiku-4-5-20251001); fall back to the base id. */
function priceFor(model: string, prices: PriceTable): ModelPrice | undefined {
  return prices[model] ?? prices[model.replace(/-\d{8}$/, '')];
}

/** Whether a model resolves to an effective price (dated-suffix aware, like Cost). */
export function isModelPriced(model: string, prices: PriceTable): boolean {
  return priceFor(model, prices) !== undefined;
}

function priceUsage(usage: ModelUsage, price: ModelPrice): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

/**
 * Cost of a set of run Usages (a single run, a task's runs, a stats
 * range), computed on read. Returns null when no run reported any usage —
 * unknown, not zero. A usage with only aggregate totals (no per-model
 * split) has tokens we cannot attribute, so it flags the result
 * incomplete without contributing dollars.
 */
export function costOfUsages(usages: (RunUsage | null)[], prices: PriceTable): Cost | null {
  const present = usages.filter((u): u is RunUsage => u !== null);
  if (present.length === 0) return null;

  const byModel: Record<string, number | null> = {};
  const merged: Record<string, ModelUsage> = {};
  let incomplete = false;

  for (const usage of present) {
    if (Object.keys(usage.models).length === 0) incomplete = true;
    for (const [model, mu] of Object.entries(usage.models)) {
      const bucket = (merged[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      bucket.inputTokens += mu.inputTokens;
      bucket.outputTokens += mu.outputTokens;
      bucket.cacheReadTokens += mu.cacheReadTokens;
      bucket.cacheWriteTokens += mu.cacheWriteTokens;
    }
  }

  let totalUsd: number | null = null;
  for (const [model, mu] of Object.entries(merged)) {
    const price = priceFor(model, prices);
    if (!price) {
      byModel[model] = null;
      incomplete = true;
      continue;
    }
    const usd = priceUsage(mu, price);
    byModel[model] = usd;
    totalUsd = (totalUsd ?? 0) + usd;
  }
  return { totalUsd, byModel, incomplete };
}
