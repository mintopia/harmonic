<!-- CURRENT: the "Ledger" premium-SaaS redesign chosen 2026-07-15, replacing
     the terminal-native "Signal Console" direction of 2026-07-14 (full restart
     decided after four visual direction probes; the Stripe-lane probe B won,
     with the dark theme revised from slate to zinc on operator feedback).
     Where running code and this file disagree, this file wins for new work. -->

---
name: Harmonic
description: Premium-SaaS operator console for running and reviewing autonomous coding agents
colors:
  indigo-accent: "#5851e0"
  indigo-accent-dark: "#7a74f0"
  zinc-canvas-light: "#f5f5f6"
  zinc-canvas-dark: "#17171a"
  shell-light: "#ffffff"
  shell-dark: "#1c1c20"
  surface-light: "#ffffff"
  surface-dark: "#212126"
  raised-light: "#ececee"
  raised-dark: "#2a2a31"
  hairline-light: "#e5e5e8"
  hairline-dark: "#2c2c33"
  edge-light: "#d8d8dc"
  edge-dark: "#3a3a43"
  ink-light: "#202024"
  ink-dark: "#e9e9ec"
  muted-light: "#5c5c66"
  muted-dark: "#a6a6b0"
  faint-light: "#9a9aa2"
  faint-dark: "#6f6f7a"
  running-amber-light: "#8a5410"
  running-amber-dark: "#e4b25c"
  accept-green-light: "#196c47"
  accept-green-dark: "#5ecc98"
  fail-red-light: "#b3382e"
  fail-red-dark: "#f07d74"
  tool-teal-light: "#0f6e7e"
  tool-teal-dark: "#5cc6d6"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.84375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.025em"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  chip: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-accent}"
    textColor: "#ffffff"
    typography: "{typography.body} at weight 600"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    shadow: "0 1px 2px rgb(88 81 224 / 0.35) (light only)"
  button-ghost:
    backgroundColor: "{colors.surface-light} / {colors.surface-dark}"
    border: "1px solid edge"
    textColor: "ink"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  field:
    backgroundColor: "field (white / #1a1a1e)"
    border: "1px solid edge; accent on focus"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  chip-state:
    typography: "{typography.label} at weight 500, uppercase"
    rounded: "{rounded.chip}"
    padding: "2px 8px"
    fill: "state tint behind state text color"
  card:
    backgroundColor: "surface"
    rounded: "{rounded.lg}"
    shadow: "soft real shadow in light; lightness step + subtle shadow in dark"
  nav-item:
    textColor: "muted; active = accent text on accent tint"
    rounded: "{rounded.md}"
    padding: "6px 10px"
---

# Design System: Harmonic

## 1. Overview

**Creative North Star: "The Ledger"**

Harmonic renders as a premium-SaaS operator console in the Stripe lane: white (or zinc-dark) cards floating on a quiet neutral field, order carried by typographic hierarchy and real depth rather than darkness or ornament. The interface speaks a quiet system sans; machine data — ids, commands, costs, models, streams — answers in monospace. One indigo is the only voice the interface itself speaks; every other color belongs to the *work* (running, accepted, failed, tooling). The register is product (PRODUCT.md: "fast, dense, operator-grade… the tool disappears into the task"), and the layout serves a side-monitor glance: a slim sidebar, a status strip, full-width working views, a board readable in two seconds.

Both themes are first-class (decided 2026-07-15): **light** is cool-neutral zinc with white cards and soft real shadows; **dark** is the same product on zinc surfaces (#17171a → #1c1c20 → #212126) where depth comes from lightness steps. The dark palette is deliberately *zinc, not slate* — no blue cast in the neutrals; the indigo accent is the only cool voice. Theme follows `prefers-color-scheme` with a manual override (System → Light → Dark) persisted in `localStorage` and stamped as `data-theme` on the root.

This system still rejects PRODUCT.md's anti-references: **CI/CD console gloom** (cards and air, not wall-of-widgets), **chat-app cuteness** (no avatars, no emoji status; agents are processes), and **kanban-tool sprawl** (the board is a queue with a review gate).

**Key Characteristics:**
- Sans-forward UI with mono reserved for data; six roles, fixed rem scale
- Cards on a field: tonal canvas, shadowed surfaces, hairlines only for shared edges inside cards
- One accent (indigo ≤10% of any screen); state colors mean states, as tinted pills
- True dual theme: light canonical-neutral, zinc dark; every pair holds AA in both
- Dense but breathable: 13.5px body, 1.5 line-height, 4/8/12/16/24 spacing rhythm

## 2. Colors: The Ledger Palette

A zinc-neutral field, one indigo accent, and a strict semantic state vocabulary; every value below passes WCAG AA against its documented background in its theme.

### Primary
- **Indigo Accent** (#5851e0 light / #7a74f0 dark): the interface's only voice. Primary actions, active nav, current selection, focus rings, the chart series. Filled buttons pair it with white text in light (#ffffff, 5.4:1) and near-black in dark (#101013, 7:1). Pressed states go darker in light (#4a43cc), lighter in dark (#8b86f3).
- **Accent Tint** (#edecfc / #2b2947): the fill under active nav items and selected pills — never a decoration.

### Neutral (zinc — near-zero chroma, both themes)
- **Canvas** (#f5f5f6 / #17171a): the page field.
- **Shell** (#ffffff / #1c1c20): sidebar and status strip.
- **Surface** (#ffffff / #212126): cards and dialogs.
- **Field** (#ffffff / #1a1a1e): form controls.
- **Raised** (#ececee / #2a2a31): inset fills — count pills, hovers, segmented track, the finished panel.
- **Hairline** (#e5e5e8 / #2c2c33): structural dividers. **Edge** (#d8d8dc / #3a3a43): interactive borders (fields, ghost buttons).
- **Ink** (#202024 / #e9e9ec): primary text. **Muted** (#5c5c66 / #a6a6b0): secondary text, ≥6:1 — the informational floor. **Faint** (#9a9aa2 / #6f6f7a): icon-only affordances and disabled text exclusively.

### Semantic states (these belong to the work, not the chrome)
Each state is a text color + a tint fill, per theme, rendered as pill chips, counts, and dots:
- **Running Amber** (#8a5410 on #fbf0dd / #e4b25c on #322b1d): work in flight.
- **Accept Green** (#196c47 on #ddf3e7 / #5ecc98 on #1d332a): completed, accepted.
- **Fail Red** (#b3382e on #fbe9e7 / #f07d74 on #372422): failed, rejected, destructive.
- **Tool Teal** (#0f6e7e on #dcf1f5 / #5cc6d6 on #1d3238): tool calls, branches, harness metadata. (Replaces Signal Console's Tool Indigo — indigo is the accent now.)
- Priority is typographic, not chromatic: high = ink + weight 600, normal/low = muted.

### Named Rules
**The One Indigo Rule.** The accent appears on at most 10% of any screen: primary action, active nav, selection, focus, the chart. If indigo is decorating something, it is wrong.
**The State Speaks Rule.** Amber, green, red, and teal are forbidden outside their semantic meanings. A color the operator can't parse as a state is noise.
**The Zinc Rule.** Neutrals carry no hue in either theme. If a gray looks blue, it's a regression; warmth or coolness may only come from the accent and the state vocabulary.

## 3. Typography

**Display/Body Font:** system sans (ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto)
**Data Font:** JetBrains Mono (400 + 600) — data only

**Character:** A quiet system sans carries the interface; an engineered monospace answers wherever the operator reads machine output. Hierarchy is built from fixed rem roles and three working weights (400 body / 500 UI emphasis / 600 headings; 700 exists for the wordmark alone), with `tabular-nums` inherent everywhere numbers appear.

### Hierarchy
- **Display** (600, 1.375rem/1.25, -0.015em): page-level headings only. Rare.
- **Headline** (600, 1.125rem/1.3): dialog titles.
- **Title** (600, 0.9375rem/1.4): card/section headings, summary values.
- **Body** (400, 0.84375rem/1.5): prompts, prose, UI copy. Buttons and nav take 500–600 at body size. Prose blocks cap at 75ch; tables and streams may run full width.
- **Label** (600, 0.6875rem/1.2, +0.025em, uppercase): field labels, table headers, chips. The only uppercase in the system.
- **Data** (mono, 400/600, 0.8125rem/1.5): task ids, costs, harness · model names, branches, timestamps, log/event streams, chart figures.

### Named Rules
**The Mono Is Data Rule.** Monospace appears only where the operator reads machine data. UI chrome and prose never set in mono; a mono heading is a regression.
**The Three Weights Rule.** 400/500/600 (700 for the wordmark only). If hierarchy needs more, fix the size or the color layer.

## 4. Elevation

Depth is real but quiet, and theme-aware (the Soft Depth Rule):
- **Light:** cards float on the canvas with a soft two-layer shadow (`0 1px 2px rgb(24 24 32 / .05), 0 2px 6px rgb(24 24 32 / .06)`); floating elements (save bar, dialogs, chart tooltip) use the bar shadow (`0 4px 18px rgb(24 24 32 / .14)`). Cards carry **no borders** — never pair a border with a wide shadow (the ghost-card ban).
- **Dark:** shadows vanish on a dark field, so depth comes from lightness steps (#17171a canvas → #1c1c20 shell → #212126 surface → #2a2a31 raised). The bar-shadow token carries a 1px hairline ring in dark so floating elements still separate.
- Hairlines mark shared edges (the sidebar's edge, table rows, section dividers inside cards). Interactive affordances (fields, ghost buttons) keep 1px Edge borders; that's affordance, not enclosure.
- The focus ring is a 2px accent outline, offset 1px, everywhere.

## 5. Components

### Buttons
- **Primary:** accent fill, white/near-black text, 8px radius, 8px 14px padding, weight 600, small accent shadow in light. One per view.
- **Ghost:** surface fill with 1px Edge border, ink text; hover darkens the border.
- **Quiet:** muted text, weight 500, hover to ink; destructive quiet actions hover to fail red.
- **Review gate:** Accept/Reject are tinted pills (green tint / red tint at weight 600) — the loudest thing on a card, one click from the board.
- **Hover / Focus:** 150ms ease-out transitions; 2px accent `:focus-visible` outline. **Disabled:** 50% opacity, no hover response.

### Chips (state & metadata badges)
- Full-pill (999px), Label typography at weight 500, 2px 8px padding.
- **State:** state tint fill behind the state's text color. Neutral metadata: Raised fill, muted text.
- Chips whose content is machine data set their text in the Data face.

### Switches
On/off is a pill switch: 32×18px track, Edge fill off / accent fill on, white knob, 150ms slide (instant under reduced motion). Used by the strip's auto-runner toggle and every boolean setting.

### Cards / Containers
- 10px radius, Surface fill, card shadow, 14–20px padding; card stacks gap at 12–16px.
- Task cards hover with a 1px Edge ring (they're clickable); section cards don't.
- Metadata inside cards is one truncating Data-role line — never chip slabs.
- **Never nest cards.** Content inside a card groups with hairlines or a Raised inset fill (harness rows, the channel add-form).

### Navigation (the Sidebar)
- Slim fixed left sidebar (200px, collapsible to 48px icon width) on Shell with a hairline right edge. Brand = 20px accent-filled rounded mark ("H") + wordmark at 700. Views (Board / Table / Stats / API / Settings) as the primary group; theme cycle + Log out pinned bottom.
- Items: body size at weight 500, muted → hover raises on Raised → **active is accent text on Accent Tint at 600** — the sidebar's only indigo.
- Icons: minimal inline-SVG line set (16px frame, 1.5 stroke, `currentColor` — `web/src/components/Icon.tsx`). No emoji, no icon fonts.
- Collapse behavior, `localStorage` persistence, and the sub-900px top drawer carry over unchanged from the Signal Console spec (issue 21); collapsed items keep `aria-label` + `title`.
- **Top strip** (Shell, hairline bottom): status, not navigation — auto-runner switch, running count with amber dot, today's cost, and the view's one primary action (New task).

### The Board (signature component)
- Active pipeline columns (Draft, Blocked, Ready, Running, Awaiting review) always expanded: flexible width (min 200px), 20px gaps, sentence-case 600 headers with **count pills** (Raised neutral; amber/red/green tint when the count means a state; faint at zero).
- Task cards stack at 12px; the Accept/Reject tinted pills sit on every awaiting-review card.
- **Terminal states live in one Finished panel**: a Raised inset panel (144px) listing Completed / Failed / Cancelled counts (fail count red when > 0). Clicking a row expands that column in place until collapsed. Full terminal history lives in the Table view. Load-independent geometry is still the point: columns never appear, vanish, or reflow as tasks move.
- Loading is a skeleton board (pulsing Raised blocks), never a spinner.

### Settings (section cards)
- Each section is a Surface card (title, one-line muted description, controls), stacked at 16px, capped at 48rem.
- Deep per-entity config (harnesses) renders as hairline-divided disclosure rows inside the card; a failed save with field errors inside forces the row open.
- **Floating save bar:** dirty state pins a rounded Surface bar (12px radius, bar shadow) 16px above the viewport bottom — "Unsaved changes · Discard / Save changes". The Save button is the view's one primary. Immediate-save sections (Notifications, Security) sit last and say so in their descriptions.

### Stats (figures & the chart)
- A divided summary card leads: cost as the hero figure (26px Data at 600), then runs/tokens/cache cells split by hairlines. Summary figures compact (18.2M); tables keep exact numbers.
- **Cost per day chart:** single indigo series — 2px line, gradient area fill to transparent, faint hairline grid, emphasized endpoint with its value, crosshair + tooltip on hover, arrow-key inspection when focused. Colors validated against both surfaces. No legend (one series; the title names it). Honest numbers: incomplete days tooltip as ≥ floors; unpriced days say so.
- Range picker is a segmented control on a Raised track; the active segment is a Surface pill at 600.

### Dialogs
Native `<dialog>`, Surface fill, 12px radius, bar shadow (hairline ring in dark), backdrop `rgb(0 0 0 / 0.5)`, 150ms fade/scale-in with a reduced-motion instant alternative.

## 6. Do's and Don'ts

### Do:
- **Do** hold the One Indigo Rule: accent only for primary action, active nav, selection, focus, the chart series — ≤10% of any screen.
- **Do** floor informational text at Muted (#5c5c66 / #a6a6b0); 4.5:1 is the contract (WCAG 2.1 AA per PRODUCT.md), and design every change in both themes before shipping it.
- **Do** build depth theme-appropriately: shadows in light, lightness steps in dark (the Soft Depth Rule).
- **Do** keep every number in `tabular-nums`, timestamps and ids in the Data role, and cost floors honest (≥, unpriced, —).
- **Do** give every interactive element default, hover, focus-visible, and disabled states, and every animation a `prefers-reduced-motion` alternative.

### Don't:
- **Don't** ship CI/CD console gloom, chat-app cuteness, or kanban-tool sprawl (PRODUCT.md anti-references).
- **Don't** pair a border with a wide shadow (ghost-card), tint the zinc neutrals toward any hue, use gradient text, glassmorphism, or side-stripe borders.
- **Don't** use state colors decoratively, set UI chrome or prose in monospace (Mono Is Data Rule), or nest cards inside cards.
- **Don't** let indigo mean anything but the interface's voice — tooling metadata is teal, there is no generic info blue, and no second accent exists.
- **Don't** reintroduce terminal cosplay (scanlines, glow, rotated rail columns) — the Signal Console is retired.
