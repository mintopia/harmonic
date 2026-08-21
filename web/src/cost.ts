import type { Cost } from './types.js';

export const usd = (v: number) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/**
 * Render a Cost as text, or null when there is nothing honest to show
 * (no usage, or nothing priceable). An incomplete aggregate is a floor,
 * shown as "≥" — never a fake exact number.
 */
export function formatCost(cost: Cost | null | undefined): string | null {
  if (!cost) return null;
  // Usage exists but none of it could be priced — distinct from "no usage".
  if (cost.totalUsd === null) return cost.incomplete ? 'unpriced' : null;
  return cost.incomplete ? `≥ ${usd(cost.totalUsd)}` : usd(cost.totalUsd);
}

/**
 * Average Cost per Run as text (ADR-0028): total Cost ÷ Run count. null — the
 * caller shows "—" — when there is nothing honest to divide (no priceable Cost,
 * or no Runs), never a fabricated $0. An incomplete aggregate is a floor, shown
 * as "≥", mirroring `formatCost`.
 */
export function formatAvgCostPerRun(cost: Cost | null | undefined, runCount: number): string | null {
  if (!cost || cost.totalUsd === null || runCount <= 0) return null;
  const avg = cost.totalUsd / runCount;
  return cost.incomplete ? `≥ ${usd(avg)}` : usd(avg);
}

/** Per-model split, priced models only; unpriced ones render as "no price". */
export function formatCostByModel(cost: Cost): string {
  return Object.entries(cost.byModel)
    .map(([model, v]) => `${model}: ${v === null ? 'no price' : usd(v)}`)
    .join(' · ');
}
