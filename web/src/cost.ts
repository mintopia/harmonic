import type { Cost } from './types.js';

export const usd = (v: number) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/**
 * Render a Cost as text, or null when there is nothing honest to show
 * (no usage, or nothing priceable). An incomplete aggregate is a floor,
 * shown as "≥" — never a fake exact number.
 */
export function formatCost(cost: Cost | null | undefined): string | null {
  if (!cost) return null;
  if (cost.totalUsd === null) return cost.incomplete ? 'unpriced' : null;
  return cost.incomplete ? `≥ ${usd(cost.totalUsd)}` : usd(cost.totalUsd);
}

/**
 * Average Cost per Attempt as text: total Cost ÷ Attempt count. null — the
 * caller shows "—" — when there is nothing honest to divide (no priceable Cost,
 * or no Attempts), never a fabricated $0. An incomplete aggregate is a floor, shown
 * as "≥", mirroring `formatCost`.
 */
export function formatAvgCostPerRun(cost: Cost | null | undefined, attemptCount: number): string | null {
  if (!cost || cost.totalUsd === null || attemptCount <= 0) return null;
  const avg = cost.totalUsd / attemptCount;
  return cost.incomplete ? `≥ ${usd(avg)}` : usd(avg);
}

