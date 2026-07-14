# Terminal-native app shell and visual system migration

Status: done

## Parent

Design system init (2026-07-14) — `PRODUCT.md` + `DESIGN.md` ("The Signal Console")

## What to build

Migrate the web UI from the current zinc + amber system to the
terminal-native target spec in `DESIGN.md`. Run `impeccable:shape` first
to plan the shell structurally, then implement.

1. **App shell**: replace the top-bar-only layout with a slim left rail
   (~200px, collapsible; top drawer on mobile) carrying the wordmark,
   views (Board / Table / Stats), and Channels / Keys / Log out pinned
   at the bottom. The strip above the working view becomes status only:
   Auto-Runner toggle, running count, period cost.
2. **Full-width working views**: drop the centered `max-w-*` containers
   on Table and Stats; data views use the whole monitor.
3. **Visual system**: apply the DESIGN.md tokens — Signal Cyan accent
   under the One Phosphor Rule, Console Black/Surface/Raised tonal
   layering, 1px Hairline borders, no shadows (Flat Field Rule),
   system sans UI with JetBrains Mono for data only (Two Weights /
   Mono Is Data Rules — amended 2026-07-14 by operator feedback on the
   issue-20 prototype), 2/4/6px radii, state colors per the State
   Speaks Rule (amber = running only; sky-blue low-priority chip
   retired, priority becomes typographic).
4. **Theme strategy**: dark canonical plus the Daylight (light) variant,
   respecting `prefers-color-scheme`; all documented AA contrast pairs
   hold in both themes.

5. **Board column treatment (decided by issue 20, 2026-07-14)**: implement
   the hybrid rail treatment in the real Board — active pipeline columns
   (Draft, Blocked, Ready, Running, Awaiting Review) always expanded
   (min ~200px, 8px gaps); terminal columns (Completed, Failed,
   Cancelled) always collapsed to ~36px vertical rails with rotated
   Label + count (Failed count in Fail Red when > 0), expanding in
   place on click. Reference: DESIGN.md § The Board and the issue-20
   prototype at `.scratch/agentdeck-v1/prototypes/20-board-columns.html`
   (variant C). The prototype is a visual reference only — its code
   does not merge.

## Acceptance criteria

- [x] Left rail shell with mobile collapse; status strip carries Auto-Runner, running count, and cost
- [x] Table and Stats render full-width
- [x] All surfaces/type/state colors match DESIGN.md; no `box-shadow` except the focus ring; mono only on data surfaces (Mono Is Data Rule)
- [x] Board implements the hybrid rail treatment per DESIGN.md § The Board
- [x] Dark + Daylight themes ship and both pass the documented AA pairs
- [x] WCAG 2.1 AA holds (contrast, keyboard paths, focus-visible, reduced motion) — no regression from issue 18
- [x] No functionality regression (board, table, task detail, stats, keys, channels)

## Blocked by

Nothing (issue 20's decision landed 2026-07-14 and is folded in above).
