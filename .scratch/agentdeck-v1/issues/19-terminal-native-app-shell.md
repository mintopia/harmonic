# Terminal-native app shell and visual system migration

Status: ready

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
   JetBrains Mono throughout (Two Weights / One Family Rules), 2/4/6px
   radii, state colors per the State Speaks Rule (amber = running only;
   sky-blue low-priority chip retired, priority becomes typographic).
4. **Theme strategy**: dark canonical plus the Daylight (light) variant,
   respecting `prefers-color-scheme`; all documented AA contrast pairs
   hold in both themes.

Board *column behavior* (dense grid vs collapsed rails) is explicitly out
of scope — it lands via issue 20's prototype decision. The board still
migrates visually (tokens, type, chips) under whichever column layout is
current.

## Acceptance criteria

- [ ] Left rail shell with mobile collapse; status strip carries Auto-Runner, running count, and cost
- [ ] Table and Stats render full-width
- [ ] All surfaces/type/state colors match DESIGN.md; no `box-shadow` except the focus ring; no second typeface
- [ ] Dark + Daylight themes ship and both pass the documented AA pairs
- [ ] WCAG 2.1 AA holds (contrast, keyboard paths, focus-visible, reduced motion) — no regression from issue 18
- [ ] No functionality regression (board, table, task detail, stats, keys, channels)

## Blocked by

Nothing (issue 20 informs the board's column layout but does not block the shell or restyle).
