import type { Conversation, PermissionAcpRequest, TaskState } from './types.js';
import type { AttemptDot } from './attempt-rail-model.js';

/** One component vocabulary (DESIGN.md § Components); screens share these
 * class strings so a button or field never drifts between surfaces. */

/** The pill buttons carry the ≥44px touch-target floor by construction (issue
 * #89): `inline-flex min-h-11 items-center justify-center` gives every primary/
 * ghost the accessible minimum height without any surface needing to remember
 * to add it. Density is unchanged — the glyph/label and padding are the same;
 * only the *minimum* height grows to the floor. */
export const btnPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-3.5 py-2 font-semibold text-on-accent shadow-btn transition-colors duration-150 hover:bg-accent-hot disabled:opacity-50 disabled:hover:bg-accent';

export const btnGhost =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-edge bg-surface px-3.5 py-2 font-medium text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50 disabled:hover:border-edge';

export const btnQuiet = 'inline-flex min-h-11 items-center font-medium text-muted transition-colors duration-150 hover:text-ink';

/** A ≥44×44px touch target (issue #56): expand the *hit area* to the accessible
 * minimum while the visual stays as compact as the layout wants. `touchTarget`
 * centres a bounded control (a segmented pill, a Stop/Grant button);
 * `touchTargetInline` is the min-height-only variant for a text link that sizes
 * its own width (a ticket deep-link, Resolve →). Compose with the control's
 * own text/colour classes. */
export const touchTarget = 'inline-flex min-h-11 min-w-11 items-center justify-center';
export const touchTargetInline = 'inline-flex min-h-11 items-center';

/** A transparent ≥44×44px hit overlay (issues #56/#89) for a compact glyph
 * that must stay visually small — a table sort header, a tab pill, the Modal's
 * ✕ — where growing the control itself would change the surface's density. The
 * parent must establish a positioning context (`relative`, or already
 * `absolute`); the `aria-hidden` span overflows into the surrounding inert
 * space, so the glyph, alignment and row height are untouched while the touch
 * target meets the floor. Clicks on the overflow merge on the parent button. */
export const touchOverlay = 'absolute left-1/2 top-1/2 size-11 -translate-x-1/2 -translate-y-1/2';

/** Quiet, but destructive (§5 Buttons: "destructive quiet actions hover to
 * fail red") — the Reject option on a permission prompt, cancel/remove
 * links elsewhere. */
export const btnQuietDestructive =
  'inline-flex min-h-11 items-center font-medium text-muted transition-colors duration-150 hover:text-fail disabled:opacity-50 disabled:hover:text-muted';

/** Solid-fail destructive — the loud end of the destructive scale, the filled
 * counterpart of btnQuietDestructive. Reserved for the confirm inside a
 * deliberate guard (a type-the-name modal), where the action is irreversible
 * and the operator has already committed to it: the delete of a Workspace and
 * everything on its board (issue #98). Not for casual/quiet destructive links —
 * those stay quiet-destructive so the loud red never becomes ambient. */
export const btnDestructive =
  'inline-flex min-h-11 items-center justify-center rounded-md bg-fail px-3.5 py-2 font-semibold text-on-fail shadow-btn transition-colors duration-150 hover:opacity-90 disabled:opacity-50 disabled:hover:opacity-50';

/** Escalation actions (DESIGN.md § 6 Buttons) — the one human surface, so this
 * is the one place a second cobalt primary is sanctioned alongside the view's
 * own ("One per view (plus the escalation surface's Accept)"). Accept is that
 * primary: the loudest thing on the card or the detail footer, and deliberately
 * unguarded, because the operator's read IS the review. Reject is the Ghost
 * beside it — present and readable, never loud; its dialog exists to take a
 * reason, not to guard the action. (It is deliberately not quiet-destructive:
 * rejecting is a normal outcome of a review, not a destructive act. Cancel,
 * which abandons a Task, is the one that gets that treatment.)
 * (Replaces the retired Ledger's accept-tint/fail-tint pill pair, which put
 * equal weight on both halves of the gate and spent state colour — green means
 * *completed*, and the task isn't — on an action rather than a state.) */
export const btnAccept = btnPrimary;
export const btnReject = btnGhost;

export const field =
  'w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none';

/** The one select-field style (issue #89): the `field` look plus the ≥44px
 * touch-target floor. A native `<select>` can't carry a transparent overlay the
 * way an icon button can, so the control itself grows to the floor via
 * `min-h-11` — the same treatment issue #56 gave the Activity/Table filters,
 * now the single definition every `<select>` in the app shares (it replaces the
 * two diverged inline `select` strings the filters had grown). Width is left to
 * the caller: full-width settings selects pass `w-full`, compact toolbar
 * filters size to their content. */
export const selectField =
  'hm-select min-h-11 rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink focus:border-accent focus:outline-none';

/** The text-input style for compact toolbar controls (issue #104 search box):
 * the `field` look plus the ≥44px touch-target floor baked in, so the floor is
 * carried by the shared vocabulary rather than re-derived inline per surface —
 * the same treatment `selectField` gave the filters (issue #89). Width is left
 * to the caller, exactly like `selectField`. */
export const searchField =
  'min-h-11 rounded-md border border-edge bg-field px-2.5 py-1.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none';

/** Label role (DESIGN.md § 3): field labels and table headers — the only
 * uppercase in the system. The tracking comes from the `--text-label` token
 * (0.05em), so don't add `tracking-*` on top of it, same as `displayTitle`. */
export const labelType = 'text-label font-semibold uppercase';

/** Page-level heading (Display role) — one per view. Weight 750 (the top of the
 * Three Weights ramp, DESIGN.md §3) via `font-display-weight`, not an ad-hoc
 * `font-bold` (700); the tracking comes from the `--text-display` token
 * (-0.015em), so don't add `tracking-*` on top of it — that's what the retired
 * Ledger did. */
export const displayTitle = 'font-display text-display font-display-weight';

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

/** Reject-continuation cost chips (issue #175, #177): the colour tracks the
 * *cost* of a re-attempt path, never a task state. The reject dialog offers
 * "continue full" — a computed warm/cold/unknown estimate — and "start
 * condensed", whose band is computed *relative to* the full path (issue #177,
 * `estimateCondensedContinuationCost`). Both paths render through this one chip:
 * `cold` reuses Running amber's tint/ink as harness-attention chrome ("this path
 * will cost you") — the one deliberate exception to DESIGN.md's "state colour on
 * the state layer only" rule; `warm`/`unknown` stay neutral — differing
 * by muted vs faint ink so cold is never the only distinguishable band. Because
 * the two paths trade places on which is cheaper, amber merges on **whichever
 * path is the pricier one right now** — never both, never dressing the cheaper
 * one up as the promoted choice. One shared vocabulary so the chip can't fork
 * registers between surfaces (#99). */
const CONTINUATION_COST_STYLES: Record<'warm' | 'cold' | 'unknown', string> = {
  cold: 'bg-running-tint text-running',
  warm: 'bg-raised text-muted',
  unknown: 'bg-raised text-faint',
};

export function continuationCostChip(band: 'warm' | 'cold' | 'unknown'): string {
  return `${chip} ${CONTINUATION_COST_STYLES[band]}`;
}

/** Permission-prompt buttons (issue #11): the ACP request's `allow_once` /
 * `allow_always` options as a review-gate-style tinted pill (affirmative,
 * loudest) and a secondary ghost variant — both in Tooling cyan, since this is
 * harness chrome, not a task-state action, so it must not read as the
 * accept/reject task vocabulary or spend the One Cobalt Rule's budget. */
export const btnPermAllow =
  'inline-flex min-h-11 items-center justify-center rounded-md bg-tool-tint px-3.5 py-2 font-semibold text-tool transition-opacity duration-150 hover:opacity-80 disabled:opacity-50 disabled:hover:opacity-100';
export const btnPermAllowSecondary =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-edge bg-surface px-3.5 py-2 font-medium text-tool transition-colors duration-150 hover:border-faint disabled:opacity-50 disabled:hover:border-edge';

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

/** State chips: tinted fill behind the state's text color (DESIGN.md: state
 * colour on the state layer only). Escalated takes the indigo "needs
 * you" hue DESIGN.md § 2 reserves for the one state that needs the operator —
 * ADR-0041 made escalated that state; working is Running amber, done is
 * Merged emerald. Failed rose is an Attempt/Run register, never a ticket state. */
export const STATE_CHIP_STYLES: Record<TaskState, string> = {
  draft: 'bg-raised text-muted',
  ready: 'bg-ready-tint text-ready',
  working: 'bg-running-tint text-running',
  escalated: 'bg-await-tint text-await',
  done: 'bg-merged text-on-done',
  cancelled: 'bg-raised text-muted',
};

export function stateChip(state: TaskState): string {
  return `${chip} ${STATE_CHIP_STYLES[state]}`;
}

/** The Board card's open-blocker count badge (ADR-0041: blocked-ness is a derived
 * count, never a state). Blocked slate by default; Failed rose when a blocker is
 * escalated or cancelled, so the ticket will not unblock on its own. */
export function blockerBadge(blockedOnFailed: boolean): string {
  return `${chip} ${blockedOnFailed ? 'bg-fail-tint text-fail' : 'bg-blocked-tint text-blocked'}`;
}

/** The human-only (HITL) badge: a mirrored ticket Harmonic never works. Neutral
 * raised/muted — HITL is not a Task state, so it borrows no state colour
 * (ADR-0041: "muted state colours, distinct icon"). */
export const hitlBadge = `${chip} inline-flex items-center gap-1 bg-raised text-muted`;

/** Conversation lifecycle chips (issue #15): active/ended are operator-facing
 * lifecycle, not the Running/Accept/Fail/Tool vocabulary the Signal
 * Rule reserves for the work itself — an active Conversation isn't
 * necessarily mid-Turn ("work in flight" is Running Amber's locked meaning,
 * and a Conversation can sit active-but-idle between Turns), so coloring it
 * amber would misstate the state. Both render in the neutral Raised
 * register, distinguished only by ink vs muted text — the same
 * non-chromatic treatment Task's own 'draft'/'cancelled' states use. */
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
  ready: 'text-ready',
  working: 'text-running',
  escalated: 'text-await',
  done: 'text-merged',
  cancelled: 'text-muted',
};

export function stateCountColor(state: TaskState, count: number): string {
  return count > 0 ? STATE_COUNT_COLORS[state] : 'text-faint';
}

/** Board column-header count pill: raised neutral until the count means
 * a state worth coloring (working amber, escalated indigo, done green). */
const STATE_COUNT_PILLS: Partial<Record<TaskState, string>> = {
  ready: 'bg-ready-tint text-ready',
  working: 'bg-running-tint text-running',
  escalated: 'bg-await-tint text-await',
  done: 'bg-merged-tint text-merged',
};

export function stateCountPill(state: TaskState, count: number): string {
  const tone =
    count === 0 ? 'bg-raised text-faint' : (STATE_COUNT_PILLS[state] ?? 'bg-raised text-muted');
  return `rounded-full px-2 py-0.5 text-label font-semibold ${tone}`;
}

/** Board column lane colour (Aurora's signal layer — DESIGN §Board): the
 * column-header underline and lane dot take the column's state colour, so the
 * board reads with colour without loading it onto the calm task cards. The
 * neutral lanes (draft/cancelled) carry no state hue, so they take the Faint
 * neutral rule — a visible lane divider, not the near-invisible hairline the
 * header underline used to fall back to (issue #87). */
const LANE_BORDER: Record<TaskState, string> = {
  draft: 'border-faint',
  ready: 'border-ready-dot',
  working: 'border-running-dot',
  escalated: 'border-await',
  done: 'border-merged-dot',
  cancelled: 'border-faint',
};
/** State fill: the state's solid dot/bar colour with no shape or size — the one
 * source of truth for every element that IS the state colour (the lane dot, the
 * board card's 5px left accent bar). State-hued rows take their dot colour;
 * the neutral draft/cancelled rows take Faint (no state hue). */
const STATE_FILL: Record<TaskState, string> = {
  draft: 'bg-faint',
  ready: 'bg-ready-dot',
  working: 'bg-running-dot',
  escalated: 'bg-await-dot',
  done: 'bg-merged-dot',
  cancelled: 'bg-faint',
};

export function laneBorder(state: TaskState): string {
  return LANE_BORDER[state];
}
export function stateFill(state: TaskState): string {
  return STATE_FILL[state];
}
export function laneDot(state: TaskState): string {
  return STATE_FILL[state];
}

/* ── Deck primitives (DESIGN.md § 5–6) ────────────────────────────────
 * The Deck reorganises the home + ticket around floating panels and
 * attention-ordered rows. These class strings are the shared vocabulary the
 * Deck surface (#182), the Ticket page (#183) and the other surfaces consume,
 * so a panel, a row, or a run chip never drifts between screens. */

/** A floating panel: a group of rows on a Surface fill, 12px radius, elevation
 * declared once (soft shadow in light, a hairline ring in dark — `shadow-card`).
 * `overflow-hidden` clips row hovers and inset dividers to the radius. Group a
 * list of rows in one panel; separate groups by the canvas between panels
 * (DESIGN.md § 4 — never bare ruled rows on the canvas). */
export const panel = 'overflow-hidden rounded-xl bg-surface shadow-card';

/** The Board's top-level section heading — Attention / Running / Pending — and
 * the Standalone sub-group title, one constant so the two can't drift (issue
 * #399). The colour is the caller's: `text-await` for the Attention section,
 * `text-ink` everywhere else. */
export const boardSectionTitle = 'text-[11px] font-bold uppercase tracking-[0.11em]';

/** The uppercase Label header above a section's panel (weight 700 — the Deck's
 * section register, distinct from `labelType`'s 600 field-label weight). The
 * 'Needs you' section is the one whose label is accent, not faint (§ 6). */
export const sectionLabel = 'text-label font-bold uppercase text-faint';
export const sectionLabelAttn = 'text-label font-bold uppercase text-await';

/** The rail's cobalt "Needs you" count badge (DESIGN.md §5): a count pill in
 * the accent, right-aligned in its nav row. This is the one sanctioned cobalt
 * in the rail besides the active item — the §5 carve-out ("a badge carries a
 * count, cobalt when it's the 'Needs you' count"), not a Signal-Rule state
 * colour. Shared here so the shell can't fork the pill's register. */
export const railBadge =
  'ml-auto min-w-5 rounded-full bg-await px-1.5 py-0.5 text-center text-label font-bold tabular-nums text-on-await';

/** State dot (DESIGN.md § 6): a ~8px round in the state's colour — the lightest
 * state signal, before a row title or a run-chip label. Reuses the lane-dot
 * mapping so the dot and the board lane can't fork colours. Running dots pulse
 * via `animate-dot-pulse` (static under prefers-reduced-motion). */
export const dot = 'size-2 rounded-full';
export function stateDot(state: TaskState): string {
  return `${dot} ${laneDot(state)}`;
}

/** The Ticket rail's section header (Attempts, Worktree, Changed files) and its count pill. */
export const railSectionHead = 'mb-2.5 flex items-center gap-2 text-label font-bold uppercase tracking-[0.1em] text-faint';
export const railSectionCount = 'rounded-full bg-raised px-[7px] text-[11px] font-bold normal-case tracking-normal text-muted';

/** AttemptDot → the dot's fill utility, shared by the Ticket run rail's chips and
 * its read-only result bar so the run-signal mapping lives in one place (the
 * pulse is applied separately in the markup, never baked in here). */
export const runDotFill: Record<AttemptDot, string> = {
  running: 'bg-running-dot',
  fail: 'bg-fail-dot',
  merged: 'bg-merged-dot',
  neutral: 'bg-edge',
};

/** Run chip (DESIGN.md § 6): one attempt in the Ticket's run rail — a state dot
 * + `Run N` and a `state · cost · duration` subline. Selected chip = Accent Tint
 * + a 1.5px cobalt ring; the rail wraps to scale to many retries. */
export const runChip =
  'flex min-w-[132px] flex-col gap-1 rounded-lg border border-edge bg-surface px-3 py-2 text-left transition-colors duration-150 hover:border-faint';
export const runChipActive =
  'flex min-w-[132px] flex-col gap-1 rounded-lg border border-transparent bg-await-tint px-3 py-2 text-left shadow-[0_0_0_1.5px_var(--hm-await)]';

/** Phase-stepper node (DESIGN.md § 6): the Run's executing → validating →
 * verifying → review → merging machine. A done step is an emerald ✓ node, the
 * current step a cobalt node, a pending step a hollow Edge node, a failed step a
 * rose ✗ node (a failed Run stops there). */
export const PHASE_NODE_STYLES = {
  done: 'border-transparent bg-merged-tint text-merged',
  current: 'border-transparent bg-accent text-on-accent',
  awaiting: 'border-transparent bg-await text-on-await',
  pending: 'border-edge text-faint',
  failed: 'border-transparent bg-fail-tint text-fail',
} as const;
export type PhaseNodeVisual = keyof typeof PHASE_NODE_STYLES;

/** Verification combined-outcome colour (DESIGN.md § 6 Verification card):
 * proceed emerald / block·escalate rose / not-reached faint — a fail-safe read
 * (inconclusive → escalate) never renders as a silent pass. */
export const VERIFICATION_OUTCOME_COLORS = {
  proceed: 'text-merged',
  fail: 'text-fail',
  'not-reached': 'text-faint',
} as const;
export type VerificationOutcomeVisual = keyof typeof VERIFICATION_OUTCOME_COLORS;
