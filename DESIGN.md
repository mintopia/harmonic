<!-- TARGET: this describes the terminal-native redesign direction chosen 2026-07-14.
     The current zinc + amber implementation migrates toward this spec; where the
     running code and this file disagree, this file wins for new work.
     Amended 2026-07-14 after the issue-20 prototype: board columns settled on the
     hybrid rail treatment, and typography revised to sans-forward with monospace
     reserved for data, per operator feedback. -->

---
name: Harmonic
description: Terminal-native operator console for running and reviewing autonomous coding agents
colors:
  signal-cyan: "#37d2f2"
  signal-cyan-deep: "#0096af"
  console-black: "#070b0d"
  console-surface: "#101518"
  console-raised: "#191f23"
  hairline: "#2d3438"
  phosphor-ink: "#e5e8eb"
  phosphor-muted: "#a2adb3"
  phosphor-faint: "#7e888e"
  running-amber: "#f2af48"
  accept-emerald: "#5ed99e"
  fail-red: "#fd736d"
  tool-indigo: "#a1a7ec"
  daylight-paper: "#f3f6f7"
  daylight-surface: "#e6eaed"
  daylight-hairline: "#c9cfd2"
  daylight-ink: "#1b2023"
  daylight-muted: "#4e575d"
  daylight-cyan: "#007798"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
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
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.05em"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.console-black}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "#76ffff"
    textColor: "{colors.console-black}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.phosphor-ink}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  field:
    backgroundColor: "{colors.console-black}"
    textColor: "{colors.phosphor-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  chip-state:
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  nav-item:
    textColor: "{colors.phosphor-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
---

# Design System: Harmonic

## 1. Overview

**Creative North Star: "The Signal Console"**

Harmonic renders as a terminal-native operator console: a near-black, cool-tinted field where a fleet's state reads like well-kept instrumentation. The interface speaks in a quiet system sans; machine data — ids, counts, costs, models — answers in monospace. Hierarchy comes from weight, size, and tonal steps, never from ornament. One electric cyan is the only voice the interface itself speaks — every other color belongs to the *work* (running, accepted, failed, tooling). The register is product (from PRODUCT.md: "fast, dense, operator-grade… the tool disappears into the task"), and the layout serves a side-monitor glance: a slim left rail for navigation, full-width working views, and a board readable in two seconds.

This system explicitly rejects PRODUCT.md's anti-references: **CI/CD console gloom** (dense is the goal, murky is not — hairlines and generous line-height keep the density legible), **chat-app cuteness** (no avatars, no emoji status, agents are processes, not pets), and **kanban-tool sprawl** (the board is a queue with a review gate, not a project-management suite).

**Key Characteristics:**
- Sans-forward UI with mono reserved for data; six roles, fixed rem scale
- Tonal depth: hairlines and surface steps, zero decorative shadows
- One accent (Signal Cyan ≤10% of any screen); state colors mean states
- Dark canonical, daylight variant for bright rooms
- Dense but breathable: 1.55 body line-height, 4/8/12/16/24 spacing rhythm

## 2. Colors: The Signal Palette

A cool near-black console field, one electric accent, and a strict semantic state vocabulary; every value below passes WCAG AA against its documented background.

### Primary
- **Signal Cyan** (#37d2f2, oklch(0.80 0.13 215)): the interface's only voice. Primary actions (New Task, Create), current selection, focus rings, active nav. 10.2:1 on Console Surface. Filled buttons pair it with Console Black text (10.9:1).
- **Signal Cyan Deep** (#0096af): pressed/active fills and the accent on Daylight surfaces where the bright cyan would wash out.

### Neutral
- **Console Black** (#070b0d): the canvas. Slightly cool (hue 235), never pure #000.
- **Console Surface** (#101518): panels, cards, dialogs — one tonal step up.
- **Console Raised** (#191f23): hover states, nested chips, the step above Surface.
- **Hairline** (#2d3438): all borders and dividers, always 1px.
- **Phosphor Ink** (#e5e8eb): primary text and data (16:1 on canvas).
- **Phosphor Muted** (#a2adb3): secondary text — labels, metadata, timestamps (8:1 on Surface). The muted floor for informational text.
- **Phosphor Faint** (#7e888e): icon-only affordances and disabled text exclusively (5.5:1; never for informational prose).

### Tertiary (semantic states — these belong to the work, not the chrome)
- **Running Amber** (#f2af48): running state only. The old brand amber lives on here as the color of work in flight.
- **Accept Emerald** (#5ed99e): completed, accepted, success.
- **Fail Red** (#fd736d): failed, rejected, destructive actions, blocked-on-failed.
- **Tool Indigo** (#a1a7ec): tool calls, branches, harness/tooling metadata.
- Priority is typographic, not chromatic: high = Phosphor Ink + weight 600, normal/low = Phosphor Muted. (Retires the old sky-blue low-priority chip, which would collide with the cyan accent.)

### Daylight variant (light theme)
Cool paper, same hues, same rules: **Daylight Paper** (#f3f6f7) canvas, **Daylight Surface** (#e6eaed) panels, **Daylight Hairline** (#c9cfd2), **Daylight Ink** (#1b2023, 15:1), **Daylight Muted** (#4e575d, 6.8:1), **Daylight Cyan** (#007798, 4.7:1 as text on Paper). State colors shift to their ramp's darker steps (documented in `.impeccable/design.json` tonal ramps). Dark is canonical; Daylight ships as a `prefers-color-scheme`-respecting option.

### Named Rules
**The One Phosphor Rule.** Signal Cyan appears on at most 10% of any screen: primary action, current selection, focus. If cyan is decorating something, it is wrong.
**The State Speaks Rule.** Amber, emerald, red, and indigo are forbidden outside their semantic meanings. A color the operator can't parse as a state is noise.

## 3. Typography

*(Amended 2026-07-14: the original mono-everything doctrine was reversed by operator feedback during the issue-20 prototype — "way too much monospace". The system is now sans-forward; monospace is reserved for data.)*

**Display/Body Font:** system sans (ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto)
**Data Font:** JetBrains Mono (with ui-monospace, SFMono-Regular, Menlo fallback) — data only

**Character:** A quiet system sans carries the interface; an engineered monospace answers wherever the operator reads machine output — terminal-native without cosplay: no scanlines, no glow. Hierarchy is built from fixed rem roles and two weights (400/600), with `tabular-nums` inherent everywhere numbers appear.

### Hierarchy
- **Display** (600, 1.375rem/1.25, -0.01em): page-level headings only (Stats, empty states). Rare.
- **Headline** (600, 1.125rem/1.3): dialog titles, section heads.
- **Title** (600, 0.9375rem/1.4): card group labels, table emphasis.
- **Body** (400, 0.8125rem/1.55): prompts, prose, UI copy. Prose blocks cap at 75ch; tables and streams may run full width.
- **Label** (500, 0.6875rem/1.2, +0.05em, uppercase): column headers, chips, state badges, meta labels. The only uppercase in the system.
- **Data** (mono, 400, 0.8125rem/1.55): task ids, costs, harness · model names, branches, timestamps, and log/event streams. Counts stay in their surrounding role (e.g. Label column headers) with `tabular-nums`.

### Named Rules
**The Two Weights Rule.** 400 and 600 only. If hierarchy needs more, fix the size or the color layer, not the weight.
**The Mono Is Data Rule.** Monospace appears only where the operator reads machine data — ids, costs, models, branches, streams. UI chrome and prose never set in mono; a mono heading is a regression.

## 4. Elevation

Flat by doctrine. Depth is conveyed by tonal layering (Console Black → Surface → Raised) and 1px Hairline borders — never by drop shadows. Dialogs separate from the page with a Hairline border and a backdrop dim (rgba(0,0,0,0.6)); the current `shadow-xl` is retired in the migration. The single permitted glow is the focus ring: a 2px Signal Cyan outline, offset 1px.

### Named Rules
**The Hairline Rule.** If an edge needs marking, it gets a 1px Hairline — not a shadow, not a thicker border, not a side-stripe.
**The Flat Field Rule.** Shadows are prohibited. An element that "needs" a shadow needs a tonal step instead. Audit test: if any `box-shadow` other than the focus ring ships, it's a defect.

## 5. Components

### Buttons
- **Shape:** subtly squared (4px radius); pills prohibited.
- **Primary:** Signal Cyan fill, Console Black text, 6px 12px padding, weight 600. One per view.
- **Ghost:** transparent with Hairline border, Phosphor Ink text; hover raises to Console Raised.
- **Text/quiet:** Phosphor Muted, hover to Phosphor Ink; destructive text actions hover to Fail Red.
- **Hover / Focus:** 150ms ease-out background/color transitions; 2px Signal Cyan `:focus-visible` outline, offset 1px.
- **Disabled:** 50% opacity, no hover response.

### Chips (state & metadata badges)
- **Style:** Label typography (uppercase 0.6875rem), 2px radius, 2px 6px padding.
- **State:** state color at ~15% opacity as background, full state color as text (e.g. Running Amber on amber-tinted Surface). Neutral metadata chips: Console Raised background, Phosphor Muted text.
- **Family:** chips whose content is machine data (harness · model, branch names) set their text in the Data face; all other chips are sans per the Label role.

### Cards / Containers
- **Corner Style:** 4px radius.
- **Background:** Console Surface on Console Black; hover steps to Console Raised.
- **Shadow Strategy:** none (Flat Field Rule); definition via Hairline border.
- **Internal Padding:** 12px; card grids gap at 8px.

### Inputs / Fields
- **Style:** Console Black inset on Surface panels, 1px Hairline border, 4px radius, Body type, 6px 10px padding.
- **Focus:** border shifts to Signal Cyan (no outline duplication inside fields).
- **Placeholder:** Phosphor Muted — never fainter.
- **Error:** border and message in Fail Red.

### Navigation (the Rail)
- **Style:** slim fixed left rail (~200px, collapsible to icon width) on Console Black with a Hairline right edge, replacing the top-bar-only shell. Wordmark top; views (Board / Table / Stats) as the primary group; Channels / Keys / Log out pinned bottom.
- **Items:** Body type, Phosphor Muted default → Phosphor Ink hover → active gets Console Raised fill plus Signal Cyan text. Active is the only cyan in the rail. Each item pairs an icon with its label; icons come from a minimal inline-SVG line set (16px frame, single 1.5 stroke weight, `currentColor`, no fills — `web/src/components/Icon.tsx`). No emoji, no icon-font dependency.
- **Collapse (settled by issue 21, 2026-07-14):** a chevron toggle in its own hairline-topped group above the pinned account group collapses the rail to icon width — 36px, the same rail vocabulary as the board's terminal columns. Collapsed items are icon-only and keep full a11y: `aria-label`, native `title` tooltip, unchanged focus ring and keyboard order. The wordmark contracts to an "AD" monogram. The choice persists in `localStorage` (default expanded); width animates 150ms ease-out with a `prefers-reduced-motion` instant alternative. Below the rail breakpoint the mobile drawer wins and the collapse never applies.
- **Top strip:** what remains above the working view is status, not navigation: Auto-Runner toggle, running count, period cost.
- **Mobile:** rail collapses to a top drawer; working views keep full width.

### The Board (signature component)
Full-width working surface; columns as tonal Surface wells with Label headers and count. Column treatment settled by the issue-20 prototype (2026-07-14): the **hybrid rail treatment**.
- **Active pipeline columns** (Draft, Blocked, Ready, Running, Awaiting Review) are always expanded: flexible width (min ~200px), 8px gaps, cards at standard 12px padding.
- **Terminal columns** (Completed, Failed, Cancelled) always collapse to slim vertical rails (~36px): rotated Label + count, Hairline border, hover raises to Console Raised. A Failed rail with count > 0 renders its count in Fail Red. Clicking a rail expands that column in place until collapsed again; the full terminal history lives in the Table view.
- **Load-independent geometry is the point**: columns never appear, vanish, or reflow as tasks move, so the operator's glance targets stay put (rejected variants: an 8-wide dense grid spent 3/8 of the board on finished work and cramped the review-gate actions; empty-column collapse reflowed the layout during exactly the busy stretches when glancing matters).

### Dialogs
Native `<dialog>` (keep the current Modal component), Console Surface panel, Hairline border, 6px radius, backdrop `rgba(0,0,0,0.6)`, 150ms fade/scale-in with a `prefers-reduced-motion` instant alternative.

## 6. Do's and Don'ts

### Do:
- **Do** hold the One Phosphor Rule: Signal Cyan (#37d2f2) only for primary action, selection, and focus — ≤10% of any screen.
- **Do** floor informational text at Phosphor Muted (#a2adb3) on dark and Daylight Muted (#4e575d) on light; 4.5:1 is the contract (WCAG 2.1 AA per PRODUCT.md).
- **Do** build depth from tonal steps (#070b0d → #101518 → #191f23) and 1px Hairlines.
- **Do** keep every number in `tabular-nums` whatever its role, and set timestamps in the Data role — live-updating digits must not jitter.
- **Do** give every interactive element default, hover, focus-visible, and disabled states, and every animation a reduced-motion alternative.

### Don't:
- **Don't** ship CI/CD console gloom (PRODUCT.md anti-reference): no wall-of-widgets, no log-soup without hierarchy; density must stay legible.
- **Don't** ship chat-app cuteness (PRODUCT.md anti-reference): no agent avatars, no emoji status, no anthropomorphizing copy.
- **Don't** ship kanban-tool sprawl (PRODUCT.md anti-reference): no swimlanes, label taxonomies, or settings creep on the board.
- **Don't** use box-shadows (Flat Field Rule), gradient text, glassmorphism, side-stripe borders, or terminal cosplay (scanlines, phosphor glow, CRT curvature).
- **Don't** use state colors decoratively, set UI chrome or prose in monospace (Mono Is Data Rule), or exceed weights 400/600.
- **Don't** let cyan and a hypothetical blue "info" state coexist — indigo covers tooling; there is no generic info blue.
