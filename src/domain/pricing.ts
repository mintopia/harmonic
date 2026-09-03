import type { ModelUsage, AttemptUsage } from './usage.js';
import type { HarnessConfig } from '../config.js';

/** Per-model API rates in $/Mtok — the four counters `AttemptUsage.models` stores. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Cost: the dollar value of Usage. Settled Attempts store this value; live
 * usage can still derive it on read. A model without a price contributes null,
 * and the whole aggregate is flagged incomplete — a partial total is a floor,
 * never a fake zero.
 */
export interface Cost {
  /** Sum over priced models; null when nothing could be priced. */
  totalUsd: number | null;
  /** $ per model; null for models without a price entry. */
  byModel: Record<string, number | null>;
  /** True when any tokens in the aggregate could not be priced. */
  incomplete: boolean;
}

/** The selected harness owns the model catalog, so identical ids may price differently. */
export function pricesForHarness(harness: Pick<HarnessConfig, 'models'>): PriceTable {
  return Object.fromEntries(harness.models.flatMap((model) => (model.price ? [[model.id, model.price]] : [])));
}

export function resolveContextWindowForHarness(model: string, harness: Pick<HarnessConfig, 'models'>): number | null {
  const base = model.replace(/-\d{8}$/, '');
  return harness.models.find((entry) => entry.id === model)?.contextWindow
    ?? harness.models.find((entry) => entry.id === base)?.contextWindow
    ?? null;
}

/** Session logs use dated ids (claude-haiku-4-5-20251001); fall back to the base id. */
function priceFor(model: string, prices: PriceTable): ModelPrice | undefined {
  return prices[model] ?? prices[model.replace(/-\d{8}$/, '')];
}

/** Whether a model resolves to an effective price (dated-suffix aware, like Cost). */
export function isModelPriced(model: string, prices: PriceTable): boolean {
  return priceFor(model, prices) !== undefined;
}

export function modelUsageCost(usage: ModelUsage, price: ModelPrice): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

/** API-equivalent cost of one model turn, including its input and cache
 * footprint. The per-tool breakdown allocates this full turn cost by output
 * share while preserving the output-token count as its primary measure. */
export function turnCost(model: string, usage: ModelUsage, prices: PriceTable): number | undefined {
  const price = priceFor(model, prices);
  return price ? modelUsageCost(usage, price) : undefined;
}

/**
 * Cost of a set of Attempt Usages (one Attempt, a task's Attempts, a stats
 * range), computed on read. Returns null when no Attempt reported any usage —
 * unknown, not zero. A usage with only aggregate totals (no per-model
 * split) has tokens we cannot attribute, so it flags the result
 * incomplete without contributing dollars.
 */
export function costOfUsages(usages: (AttemptUsage | null)[], prices: PriceTable): Cost | null {
  const present = usages.filter((u): u is AttemptUsage => u !== null);
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
    const usd = modelUsageCost(mu, price);
    byModel[model] = usd;
    totalUsd = (totalUsd ?? 0) + usd;
  }
  return { totalUsd, byModel, incomplete };
}

/**
 * Fold an Attempt's critic-review runs into its Usage and Cost for display: the
 * critic's tokens merge into the per-model Usage (so the token bar and billable
 * I/O count them under their model), while its dollars land on a single `critic`
 * key in `cost.byModel` — a slice that stands on its own rather than being
 * absorbed into the implementation model's cost. Each critic run carries its own
 * harness prices, since the reviewer can run a different harness than the build.
 * Pure: the stored Attempt row keeps only its implementation Usage/Cost.
 */
export function withCriticContribution(
  usage: AttemptUsage | null,
  cost: Cost | null,
  critics: { usage: AttemptUsage; prices: PriceTable }[],
): { usage: AttemptUsage | null; cost: Cost | null } {
  if (critics.length === 0) return { usage, cost };

  const models: Record<string, ModelUsage> = {};
  for (const [model, mu] of Object.entries(usage?.models ?? {})) models[model] = { ...mu };
  for (const critic of critics) {
    for (const [model, mu] of Object.entries(critic.usage.models)) {
      const bucket = (models[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      bucket.inputTokens += mu.inputTokens;
      bucket.outputTokens += mu.outputTokens;
      bucket.cacheReadTokens += mu.cacheReadTokens;
      bucket.cacheWriteTokens += mu.cacheWriteTokens;
    }
  }
  const mergedUsage: AttemptUsage = usage
    ? { ...usage, models }
    : { models, totals: null, toolCalls: {}, source: 'session-log' };

  let criticTotal: number | null = null;
  let criticIncomplete = false;
  for (const critic of critics) {
    const cc = costOfUsages([critic.usage], critic.prices);
    if (!cc) {
      criticIncomplete = true;
      continue;
    }
    criticIncomplete ||= cc.incomplete;
    if (cc.totalUsd !== null) criticTotal = (criticTotal ?? 0) + cc.totalUsd;
    else criticIncomplete = true;
  }

  const byModel: Record<string, number | null> = { ...(cost?.byModel ?? {}), critic: criticTotal };
  let totalUsd: number | null = null;
  for (const usd of Object.values(byModel)) if (usd !== null) totalUsd = (totalUsd ?? 0) + usd;
  const mergedCost: Cost = {
    totalUsd,
    byModel,
    incomplete: (cost?.incomplete ?? false) || criticIncomplete,
  };
  return { usage: mergedUsage, cost: mergedCost };
}

/** Sum Costs already frozen on Attempts, preserving unknown-model floors. */
export function sumCosts(costs: (Cost | null)[]): Cost | null {
  const present = costs.filter((cost): cost is Cost => cost !== null);
  if (present.length === 0) return null;

  const byModel: Record<string, number | null> = {};
  let totalUsd: number | null = null;
  let incomplete = false;
  for (const cost of present) {
    incomplete ||= cost.incomplete;
    if (cost.totalUsd !== null) totalUsd = (totalUsd ?? 0) + cost.totalUsd;
    for (const [model, usd] of Object.entries(cost.byModel)) {
      if (usd === null) {
        byModel[model] = null;
        incomplete = true;
      } else if (byModel[model] !== null) {
        byModel[model] = (byModel[model] ?? 0) + usd;
      }
    }
  }
  return { totalUsd, byModel, incomplete };
}
