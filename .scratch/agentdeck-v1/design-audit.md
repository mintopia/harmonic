# Design audit & critique — AgentDeck web UI

Issue: `issues/18-design-audit-and-polish.md` · Date: 2026-07-14 · Method: `impeccable:audit` (code-level, all of `web/src`) + `impeccable:critique` (usability), contrast ratios computed against Tailwind zinc/amber hex values.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2/4 | Muted-text contrast fails WCAG AA across the app; modals are divs, not dialogs |
| 2 | Performance | 3/4 | Lean app; EventStream renders unbounded event lists |
| 3 | Responsive design | 2/4 | Header can't wrap; tables have no overflow containment on narrow viewports |
| 4 | Theming | 3/4 | Consistent zinc + amber token use; field styles duplicated per-file |
| 5 | Anti-patterns | 4/4 | Clean — no AI tells |
| **Total** | | **14/20** | **Good — address weak dimensions** |

## Anti-patterns verdict

**Pass.** No gradient text, no glassmorphism, no side-stripe accents, no hero-metric templates, no decorative motion. The dark zinc + amber identity is restrained and consistent; state colors (emerald/red/amber/sky/indigo) form a real semantic vocabulary. The automated detector's only hits ("zinc-950 on amber-500", 5×) are false positives — that pairing measures 9.26:1. The identity is worth preserving, as the issue requires.

## Executive summary

- Score **14/20 (Good)**. 0 × P0, 3 × P1, 8 × P2, 5 × P3.
- The three P1s: (1) systemic muted-text contrast failures, (2) modal semantics/keyboard support, (3) mouse-only interactive elements.
- Everything below redesign scale is fixable within the current identity; three structural proposals are listed at the end for operator approval, not applied.

## Detailed findings

### P1 — fix before release

**[P1] Muted text fails WCAG AA contrast, systemically**
- Location: every component. `text-zinc-600` (2.57:1 on zinc-950, 2.29:1 on zinc-900) is used for empty states, task IDs, column counts, event meta lines, "nothing" placeholders. `text-zinc-500` (4.12:1 / 3.67:1) is used for section labels, table headers, timestamps, run metadata, inactive nav.
- Category: Accessibility · WCAG 1.4.3 (AA, 4.5:1)
- Impact: the app's entire secondary-information layer is hard to read; empty states and metadata are the worst offenders.
- Recommendation: informational text floors at `text-zinc-400` (6.91:1 on zinc-900, 5.75:1 on zinc-950); `text-zinc-500` remains acceptable only for icon-like affordances (✕ buttons), which need just 3:1 as UI components. Add `placeholder:text-zinc-400` where placeholders act as labels (3.08:1 default is illegible).
- Command: `$impeccable polish`

**[P1] Modals are positioned divs, not dialogs**
- Location: TaskDetail.tsx:213, TaskForm.tsx:57, ApiKeys.tsx:42, Channels.tsx:78
- Category: Accessibility · WCAG 2.1.2 / 4.1.2
- Impact: no `role="dialog"`, no focus trap, no Escape-to-close, no focus restore; background stays in tab order, screen readers announce nothing. All four also duplicate the same overlay markup, and stacked modals rely on DOM order (all `z-10`).
- Recommendation: one shared `Modal` on the native `<dialog>` element (`showModal()` gives focus trap, Esc, top-layer stacking, focus restore for free); backdrop click closes via `e.target === dialog`.
- Command: `$impeccable harden`

**[P1] Mouse-only interactive elements**
- Location: TaskCard.tsx:28 (prompt is a `<p onClick>`), TableView.tsx:89 (row `<tr onClick>`), TableView.tsx:31 (sortable `<th onClick>`)
- Category: Accessibility · WCAG 2.1.1
- Impact: the primary way to open a task is unreachable by keyboard; sorting is unreachable by keyboard.
- Recommendation: real `<button>`s (text-left, w-full) for card prompt and sort headers; a button inside the row's prompt cell so rows stay pointer-clickable but gain a keyboard path.
- Command: `$impeccable harden`

### P2 — next pass

**[P2] Icon-only ✕ buttons have no accessible name** — TaskDetail (close, remove dependency, remove channel), ApiKeys, Channels. Screen readers read "multiplication sign". Add `aria-label`. (WCAG 4.1.2)

**[P2] Unlabeled form controls** — Login inputs are placeholder-only (also missing `autocomplete="username"` / `"current-password"`); TableView filter selects, Dependencies "+ add…" select, NotifyOverrides "+ route to…" select have no accessible names. Add `aria-label`s / autocomplete. (WCAG 1.3.5, 4.1.2)

**[P2] Auto-Runner toggle exposes no state** — App.tsx:87. Visual-only on/off; add `aria-pressed`. (WCAG 4.1.2)

**[P2] No keyboard focus indicator on buttons** — header nav, card actions, etc. rely on the browser default ring, nearly invisible on zinc-950. Add a global `:focus-visible` outline (amber) in index.css; form fields already swap border color but use `focus:outline-none`, so they keep their indicator.

**[P2] Header overflows on narrow viewports** — App.tsx:68. `flex` without wrap; at <900px the nav + auto-runner + four buttons clip/overflow. Allow wrapping. (Responsive)

**[P2] Tables have no horizontal containment** — TableView.tsx:74 (8 columns), ApiKeys table. On mobile they force page-level squish. Wrap in `overflow-x-auto`. (Responsive)

**[P2] Loading state indistinguishable from empty** — TableView flashes "No tasks match." before the first fetch resolves; a filtered fetch also leaves stale rows visible while loading. Track a loaded flag. Board similarly can't distinguish "loading" from "no tasks yet" (see onboarding note below).

**[P2] EventStream renders unbounded lists** — EventStream.tsx:45. A long run streams thousands of DOM rows into the modal. Acceptable today; virtualize or window if runs grow. (Performance — recommendation only, see proposals.)

### P3 — polish

**[P3] Cost column alignment** — TableView cost cells (issue 17 surface) are left-aligned prose-style; numeric columns should right-align with `tabular-nums` so amounts scan. Stats tiles and token counts also lack `tabular-nums`, so live-updating numbers jitter.
**[P3] Gutter misalignment** — header uses `px-6`, main uses `p-4`; content edge doesn't line up with the wordmark.
**[P3] TaskForm grid is 2-col even at 360px** — cramped selects; collapse to one column below `sm`.
**[P3] Dialog appearance is instant** — a 150ms fade/scale on open (with `prefers-reduced-motion` guard) is the product-register norm; motion conveys state.
**[P3] Badge type sizes drift** — text-[10px] / text-[11px] / text-xs mix across badges; harmless but worth normalizing opportunistically.

## Patterns & systemic issues

1. **Contrast is a policy gap, not a one-off** — zinc-500/600 chosen for "muted" everywhere without a floor. Fix is a palette rule (informational text ≥ zinc-400), not spot edits.
2. **Modal markup duplicated 4×** — same overlay/panel classes copy-pasted; one `Modal` component removes the duplication and carries the a11y fixes to all four at once.
3. **Field styles duplicated per-file** — the `field`/`label`/`select` class strings appear in TaskForm, Channels, Login, TableView with slight drift. Candidate for `$impeccable extract` later; not user-visible, so out of scope for this pass.

## Positive findings

- Restrained color strategy done right: one amber accent for primary actions/selection, tinted state chips, everything else neutral. Exactly the product register.
- Real empty states everywhere data can be empty ("No tasks match.", "No keys yet.", "No events.").
- Honest cost formatting (`≥` floors, "unpriced" vs "—") carried consistently across TaskDetail, TableView, StatsPage.
- Kanban board's `auto-cols` + `overflow-x-auto` horizontal scroll is the correct structural response for 8 columns.
- Dark-only via `color-scheme: dark` is a deliberate, coherent identity choice for an operator tool.

## Critique — usability & structure

- **Hierarchy**: header reads correctly (wordmark → views → status → primary action). The primary "New Task" is the only filled button — good.
- **First-run experience**: a new operator sees 8 empty columns and no guidance. An empty-board state that points at "New Task" teaches the interface (applied in this pass — it's small).
- **Feedback affordances**: `window.prompt()` / `alert()` / `confirm()` for rejection feedback, re-queue feedback, errors, and cascade-cancel. Functional but jarring and unstylable. Replacing them is redesign-scale (needs an inline form/toast system) — proposed below, not applied.
- **Board information scent**: cards show harness · model, priority, isolation, deps — the right density for triage. No complaints.

## Redesign-scale proposals (for approval — NOT applied)

1. **Inline feedback + toast system** replacing `window.prompt`/`alert`/`confirm` (reject/re-queue feedback as inline popover forms; errors as toasts). Touches every action path; needs a design decision.
2. **Board column management** — 8 always-visible columns push real work off-screen once terminal states accumulate; consider collapsing empty terminal columns (Cancelled/Failed) to slim rails, or a column visibility preference.
3. **EventStream virtualization** for very long runs (windowing library or capped render with "show earlier" control).

## Recommended actions (applied in this pass)

1. **[P1] `$impeccable harden`** — shared native-`<dialog>` Modal; keyboard paths for card prompt / table rows / sort headers.
2. **[P1] `$impeccable polish`** — contrast sweep to the zinc-400 floor; placeholder contrast; focus-visible outline.
3. **[P2] `$impeccable adapt`** — header wrap, table overflow containment, TaskForm mobile grid.
4. **[P2] `$impeccable clarify`** — aria-labels, aria-pressed, autocomplete, loading-vs-empty distinction, empty-board hint.
5. **[P3] `$impeccable typeset`/`polish`** — tabular-nums, cost column right-alignment, gutter alignment, dialog entry motion with reduced-motion guard.
