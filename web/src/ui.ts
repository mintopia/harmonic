import type { Conversation, PermissionAcpRequest, TaskState } from './types';

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

/** Review-gate actions (DESIGN.md § 6 Buttons) — the product's core promise,
 * so this is the one place a second cobalt primary is sanctioned alongside the
 * view's own ("One per view (plus the review gate's Accept)"). Accept is that
 * primary: the loudest thing on the card or the detail footer, and deliberately
 * unguarded, because the operator's read IS the review. Reject is quiet and
 * destructive; its dialog exists to take a reason, not to guard the action.
 * (Replaces the retired Ledger's accept-tint/fail-tint pill pair, which put
 * equal weight on both halves of the gate and spent state colour — green means
 * *completed*, and the task isn't — on an action rather than a state.) */
export const btnAccept = btnPrimary;
export const btnReject = btnGhost; // PROTOTYPE C

export const field =
  'w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none';

/** Label role (DESIGN.md § 3): field labels and table headers — the only
 * uppercase in the system. The tracking comes from the `--text-label` token
 * (0.05em), so don't add `tracking-*` on top of it, same as `displayTitle`. */
export const labelType = 'text-label font-semibold uppercase';

/** Page-level heading (Display role) — one per view. Weight 700; the tracking
 * comes from the `--text-display` token (-0.015em), so don't add `tracking-*`
 * on top of it — that's what the retired Ledger did. */
export const displayTitle = 'font-display text-display font-bold';

/** The title of a dialog or a floating panel — its own view, so the Display
 * role, same as a page title. Pair with the surface's own bottom margin, e.g.
 * `${panelTitle} mb-4`. (Replaces the retired "Headline" role: DESIGN.md § 3
 * defines Display / Hero / Title / Body / Small / Label / Code and nothing
 * between Title and Display, so `--text-headline` had no owner.) */
export const panelTitle = displayTitle;

/** Section heading inside a card (Title role). Reach for this — not
 * `labelType` — for anything that names a section: Label is reserved for
 * field labels and table headers (DESIGN.md § 3), so a Label-role heading
 * renders identically to `tableHead` below and merges into the table it
 * introduces. */
export const sectionTitle = 'text-title font-semibold text-ink';

/** Table header row: Label-role muted text on every table in the app. */
export const tableHead = `${labelType} text-muted`;

/** Cards float on the canvas: shadow in light, a lightness step in dark —
 * never a border (the Soft Depth Rule). */
export const card = 'rounded-lg bg-surface shadow-card';

/** Uppercase micro-pill; pass the tint classes for semantic states. Weight 600
 * and the token's 0.05em tracking (DESIGN.md § 6: "Small (11px, weight 600)"). */
export const chip = 'rounded-full px-2 py-0.5 text-label font-semibold uppercase';

/** Tool call / permission chip — harness metadata, Tooling cyan (the Signal
 * Rule). Shared by EventStream's tool-call lines and the permission
 * prompt (issue #11). */
export const toolChip = `${chip} bg-tool-tint text-tool`;

/** Permission-prompt buttons (issue #11): the ACP request's `allow_once` /
 * `allow_always` options as a review-gate-style tinted pill (affirmative,
 * loudest) and a secondary ghost variant — both in Tooling cyan, since this is
 * harness chrome, not a task-state action, so it must not read as the
 * accept/reject task vocabulary or spend the One Cobalt Rule's budget. */
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

/** State chips: tinted fill behind the state's text color (the Signal
 * Rule — only true states get a color). */
export const STATE_CHIP_STYLES: Record<TaskState, string> = {
  draft: 'bg-raised text-muted',
  blocked: 'bg-blocked-tint text-blocked',
  ready: 'bg-ready-tint text-ready',
  running: 'bg-running-tint text-running',
  'awaiting-review': 'bg-accent-tint text-accent',
  completed: 'bg-accept-tint text-accept',
  failed: 'bg-fail-tint text-fail',
  cancelled: 'bg-raised text-muted',
};

export function stateChip(state: TaskState): string {
  return `${chip} ${STATE_CHIP_STYLES[state]}`;
}

/** Conversation lifecycle chips (issue #15): active/ended are operator-facing
 * lifecycle, not the Running/Accept/Fail/Tool vocabulary the Signal
 * Rule reserves for the work itself — an active Conversation isn't
 * necessarily mid-Turn ("work in flight" is Running Amber's locked meaning,
 * and a Conversation can sit active-but-idle between Turns), so coloring it
 * amber would misstate the state. Both render in the neutral Raised
 * register, distinguished only by ink vs muted text — the same
 * non-chromatic treatment Task's own 'ready'/'awaiting-review' states use. */
const CONVERSATION_STATE_CHIP_STYLES: Record<Conversation['state'], string> = {
  active: 'bg-raised text-ink',
  ended: 'bg-raised text-muted',
};

export function conversationStateChip(state: Conversation['state']): string {
  return `${chip} ${CONVERSATION_STATE_CHIP_STYLES[state]}`;
}

/** Count/figure color per state (the Signal Rule): color appears
 * only where it means state, and only when the count is non-zero. */
const STATE_COUNT_COLORS: Record<TaskState, string> = {
  draft: 'text-muted',
  blocked: 'text-blocked',
  ready: 'text-ready',
  running: 'text-running',
  'awaiting-review': 'text-accent',
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
  blocked: 'bg-blocked-tint text-blocked',
  ready: 'bg-ready-tint text-ready',
  running: 'bg-running-tint text-running',
  'awaiting-review': 'bg-accent-tint text-accent',
  completed: 'bg-accept-tint text-accept',
  failed: 'bg-fail-tint text-fail',
};

export function stateCountPill(state: TaskState, count: number): string {
  const tone =
    count === 0 ? 'bg-raised text-faint' : (STATE_COUNT_PILLS[state] ?? 'bg-raised text-muted');
  return `rounded-full px-2 py-0.5 text-label font-semibold ${tone}`;
}

/** Board column lane colour (Aurora's signal layer — DESIGN §Board): the
 * column-header underline and lane dot take the column's state colour, so the
 * board reads with colour without loading it onto the calm task cards. */
const LANE_BORDER: Record<TaskState, string> = {
  draft: 'border-hairline',
  blocked: 'border-blocked',
  ready: 'border-ready-dot',
  running: 'border-running-dot',
  'awaiting-review': 'border-accent',
  completed: 'border-accept-dot',
  failed: 'border-fail-dot',
  cancelled: 'border-hairline',
};
const LANE_DOT: Record<TaskState, string> = {
  draft: 'bg-faint',
  blocked: 'bg-blocked',
  ready: 'bg-ready-dot',
  running: 'bg-running-dot',
  'awaiting-review': 'bg-accent',
  completed: 'bg-accept-dot',
  failed: 'bg-fail-dot',
  cancelled: 'bg-faint',
};

export function laneBorder(state: TaskState): string {
  return LANE_BORDER[state];
}
export function laneDot(state: TaskState): string {
  return LANE_DOT[state];
}
