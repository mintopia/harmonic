import type { PermissionAcpRequest, TaskState } from './types';

/** One component vocabulary (DESIGN.md § Components); screens share these
 * class strings so a button or field never drifts between surfaces. */

export const btnPrimary =
  'rounded-md bg-accent px-3.5 py-2 font-semibold text-on-accent shadow-btn transition-colors duration-150 hover:bg-accent-hot disabled:opacity-50 disabled:hover:bg-accent';

export const btnGhost =
  'rounded-md border border-edge bg-surface px-3.5 py-2 font-medium text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50 disabled:hover:border-edge';

export const btnQuiet = 'font-medium text-muted transition-colors duration-150 hover:text-ink';

/** Quiet, but destructive (§5 Buttons: "destructive quiet actions hover to
 * fail red") — the Reject option on a permission prompt, cancel/remove
 * links elsewhere. */
export const btnQuietDestructive =
  'font-medium text-muted transition-colors duration-150 hover:text-fail disabled:opacity-50 disabled:hover:text-muted';

/** Review-gate actions: tinted pills, the loudest thing on a card. */
export const btnAccept =
  'rounded-md bg-accept-tint px-2.5 py-1 font-semibold text-accept transition-opacity duration-150 hover:opacity-80';
export const btnReject =
  'rounded-md bg-fail-tint px-2.5 py-1 font-semibold text-fail transition-opacity duration-150 hover:opacity-80';

export const field =
  'w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none';

export const labelType = 'text-label font-semibold uppercase tracking-wide';

/** Page-level heading (Display role) — one per view. Space Grotesk display face. */
export const displayTitle = 'font-display text-display font-semibold tracking-tight';

/** Dialog headline (Headline role): the display face at 600. Pair with the
 * dialog's own bottom margin, e.g. `${headline} mb-4`. */
export const headline = 'font-display text-headline font-semibold';

/** Table header row: Label-role muted text on every table in the app. */
export const tableHead = `${labelType} text-muted`;

/** Cards float on the canvas: shadow in light, a lightness step in dark —
 * never a border (the Soft Depth Rule). */
export const card = 'rounded-lg bg-surface shadow-card';

/** Uppercase micro-pill; pass the tint classes for semantic states. */
export const chip = 'rounded-full px-2 py-0.5 text-label font-medium uppercase tracking-wide';

/** Tool call / permission chip — harness metadata, Tool Teal (the State
 * Speaks Rule). Shared by EventStream's tool-call lines and the permission
 * prompt (issue #11). */
export const toolChip = `${chip} bg-tool-tint text-tool`;

/** Permission-prompt buttons (issue #11): the ACP request's `allow_once` /
 * `allow_always` options as a review-gate-style tinted pill (affirmative,
 * loudest) and a secondary ghost variant — both in Tool Teal, since this is
 * harness chrome, not a task-state action, so it must not read as the
 * accept/reject task vocabulary or spend the One Indigo Rule's budget. */
export const btnPermAllow =
  'rounded-md bg-tool-tint px-3.5 py-2 font-semibold text-tool transition-opacity duration-150 hover:opacity-80 disabled:opacity-50 disabled:hover:opacity-100';
export const btnPermAllowSecondary =
  'rounded-md border border-edge bg-surface px-3.5 py-2 font-medium text-tool transition-colors duration-150 hover:border-faint disabled:opacity-50 disabled:hover:border-edge';

const PERMISSION_OPTION_STYLES: Record<PermissionAcpRequest['options'][number]['kind'], string> = {
  allow_once: btnPermAllow,
  allow_always: btnPermAllowSecondary,
  reject_once: btnQuietDestructive,
  reject_always: btnQuietDestructive,
};

/** Maps an ACP option's `kind` to its button treatment (issue #11): allow
 * once is the affirmative pill, allow-always a secondary ghost, both
 * reject kinds the quiet-destructive link — never the task-review
 * accept/reject vocabulary (that means something else: Task state). */
export function permissionOptionButtonClass(kind: PermissionAcpRequest['options'][number]['kind']): string {
  return PERMISSION_OPTION_STYLES[kind] ?? btnQuiet;
}

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
