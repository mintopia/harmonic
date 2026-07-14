import type { TaskState } from './types';

/** One component vocabulary (DESIGN.md § Components); screens share these
 * class strings so a button or field never drifts between surfaces. */

export const btnPrimary =
  'rounded-md bg-accent px-3 py-1.5 font-semibold text-on-accent transition-colors duration-150 hover:bg-accent-hot disabled:opacity-50 disabled:hover:bg-accent';

export const btnGhost =
  'rounded-md border border-hairline px-3 py-1.5 text-ink transition-colors duration-150 hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent';

export const btnQuiet = 'text-muted transition-colors duration-150 hover:text-ink';

/** Console Black inset on Surface panels; focus shifts the border to cyan. */
export const field =
  'w-full rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none';

export const labelType = 'text-label font-medium uppercase tracking-wider';

/** Uppercase micro-chip; pass the tint classes for semantic states. */
export const chip = 'rounded-sm px-1.5 py-0.5 text-label tracking-wider';

/** State chips: state color at ~15% opacity behind full state color
 * (the State Speaks Rule — only true states get a color). */
export const STATE_CHIP_STYLES: Record<TaskState, string> = {
  draft: 'bg-raised text-muted',
  blocked: 'bg-raised text-muted',
  ready: 'bg-raised text-ink',
  running: 'bg-running/15 text-running',
  'awaiting-review': 'bg-raised text-ink',
  completed: 'bg-accept/15 text-accept',
  failed: 'bg-fail/15 text-fail',
  cancelled: 'bg-raised text-muted',
};

export function stateChip(state: TaskState): string {
  return `${chip} uppercase font-medium ${STATE_CHIP_STYLES[state]}`;
}
