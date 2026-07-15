import type { TaskState } from './types';

/** One component vocabulary (DESIGN.md § Components); screens share these
 * class strings so a button or field never drifts between surfaces. */

export const btnPrimary =
  'rounded-md bg-accent px-3.5 py-2 font-semibold text-on-accent shadow-btn transition-colors duration-150 hover:bg-accent-hot disabled:opacity-50 disabled:hover:bg-accent';

export const btnGhost =
  'rounded-md border border-edge bg-surface px-3.5 py-2 font-medium text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50 disabled:hover:border-edge';

export const btnQuiet = 'font-medium text-muted transition-colors duration-150 hover:text-ink';

/** Review-gate actions: tinted pills, the loudest thing on a card. */
export const btnAccept =
  'rounded-md bg-accept-tint px-2.5 py-1 font-semibold text-accept transition-opacity duration-150 hover:opacity-80';
export const btnReject =
  'rounded-md bg-fail-tint px-2.5 py-1 font-semibold text-fail transition-opacity duration-150 hover:opacity-80';

export const field =
  'w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none';

export const labelType = 'text-label font-semibold uppercase tracking-wide';

/** Page-level heading (Display role) — one per view. */
export const displayTitle = 'text-display font-semibold tracking-tight';

/** Table header row: Label-role muted text on every table in the app. */
export const tableHead = `${labelType} text-muted`;

/** Cards float on the canvas: shadow in light, a lightness step in dark —
 * never a border (the Soft Depth Rule). */
export const card = 'rounded-lg bg-surface shadow-card';

/** Uppercase micro-pill; pass the tint classes for semantic states. */
export const chip = 'rounded-full px-2 py-0.5 text-label font-medium uppercase tracking-wide';

/** State chips: tinted fill behind the state's text color (the State
 * Speaks Rule — only true states get a color). */
export const STATE_CHIP_STYLES: Record<TaskState, string> = {
  draft: 'bg-raised text-muted',
  blocked: 'bg-raised text-muted',
  ready: 'bg-raised text-ink',
  running: 'bg-running-tint text-running',
  'awaiting-review': 'bg-raised text-ink',
  completed: 'bg-accept-tint text-accept',
  failed: 'bg-fail-tint text-fail',
  cancelled: 'bg-raised text-muted',
};

export function stateChip(state: TaskState): string {
  return `${chip} ${STATE_CHIP_STYLES[state]}`;
}

/** Count/figure color per state (the State Speaks Rule): color appears
 * only where it means state, and only when the count is non-zero. */
const STATE_COUNT_COLORS: Record<TaskState, string> = {
  draft: 'text-muted',
  blocked: 'text-muted',
  ready: 'text-ink',
  running: 'text-running',
  'awaiting-review': 'text-ink',
  completed: 'text-accept',
  failed: 'text-fail',
  cancelled: 'text-muted',
};

export function stateCountColor(state: TaskState, count: number): string {
  return count > 0 ? STATE_COUNT_COLORS[state] : 'text-faint';
}

/** Board column-header count pill: raised neutral until the count means
 * a state worth coloring (running amber, failed red, completed green). */
const STATE_COUNT_PILLS: Partial<Record<TaskState, string>> = {
  running: 'bg-running-tint text-running',
  completed: 'bg-accept-tint text-accept',
  failed: 'bg-fail-tint text-fail',
};

export function stateCountPill(state: TaskState, count: number): string {
  const tone =
    count === 0 ? 'bg-raised text-faint' : (STATE_COUNT_PILLS[state] ?? 'bg-raised text-muted');
  return `rounded-full px-2 py-0.5 text-label font-semibold ${tone}`;
}
