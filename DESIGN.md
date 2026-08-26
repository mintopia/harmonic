<!-- CURRENT: the "Paper" operator redesign, chosen 2026-08-21, replacing the
     "Deck" direction of 2026-08-19 (itself replacing Aurora 2026-07-16 → Ledger
     2026-07-15 → Signal Console 2026-07-14). Deck had the right *structure* —
     attention-ordered surfaces, a full Ticket page with a run rail, workflow-
     shaped IA — but its cobalt "premium-console" skin and panelled row-lists were
     reworked from a throwaway "epic frontier DAG" sketch (Jess, 2026-08-21) that
     read the fleet more clearly than the live UI.

     Paper keeps everything of Deck's that was workflow truth and replaces the
     visual world and the epic IA:
       · World: cool matte "Paper" — a low-chroma paper canvas, a teal action
         accent (not cobalt), a warm-neutral dark. Serious and restrained, never
         a metaphor or costume: no paper texture, no skeuomorphism. "Paper" names
         a quiet matte register, not a picture.
       · Two voices, deliberately: teal is the interface's action/tooling voice;
         indigo is reserved for the one state that needs the operator —
         escalated / "needs you." Deck's "awaiting-review = the accent" is
         retired; in Paper the escalated state owns its own hue.
       · Board (home): attention-ordered sections — Needs you → Active → Epics →
         Standalone — as horizontal card strips (Needs you / Active) and
         collapsible Epic bands that expand to a frontier-DAG (Frontier + Depth
         columns), not panelled row-lists.
       · Vocabulary: "merged" / "merging", never "landing" / "landed", on every
         surface (code-internal landBranch / EpicLandCoordinator unaffected).

     Retired with Deck: the cobalt one-accent framing, the panelled-list Deck
     home, and every Deck token below. The shipped Paper implementation and this
     file are the design reference.
     Accessibility decisions from the 2026-08-21 audit are recorded inline in § 2;
     the running-amber sub-AA exception is ADR-0033. -->

---
name: Harmonic
description: Operator console for running and reviewing autonomous coding agents. Matte "Paper" world, teal action voice, indigo review voice, workflow-shaped surfaces, frontier-DAG epics
designSystem: Paper
colors:
  accent: "#0D7271"
  accent-dark: "#33BDB4"
  accent-hover: "#0B6360"
  accent-hover-dark: "#4CD0C7"
  accent-tint-light: "#E0F0EF"
  accent-tint-dark: "#123330"
  on-accent-light: "#FFFFFF"
  on-accent-dark: "#0E1413"
  canvas-light: "#F1F2EF"
  canvas-dark: "#15161A"
  shell-light: "#FFFFFF"
  shell-dark: "#1B1D22"
  surface-light: "#FFFFFF"
  surface-dark: "#202227"
  raised-light: "#EEEFEB"
  raised-dark: "#282B31"
  sunken-light: "#FAFAF8"
  sunken-dark: "#191B1F"
  field-light: "#FFFFFF"
  field-dark: "#1B1D22"
  hairline-light: "#E6E7E2"
  hairline-dark: "#2C2F36"
  edge-light: "#D5D8D1"
  edge-dark: "#3B3F47"
  edge-strong-light: "#D5D8D1"
  edge-strong-dark: "#454B54"
  ink-light: "#1B1E24"
  ink-dark: "#E8E9EC"
  muted-light: "#656B73"
  muted-dark: "#A3A8B0"
  faint-light: "#61676F"
  faint-dark: "#979BA2"
  ready-text-light: "#0D7271"
  ready-tint-light: "#DDEFEE"
  ready-text-dark: "#33BDB4"
  ready-tint-dark: "#123330"
  await-text-light: "#4B4FA6"
  await-tint-light: "#ECEDF7"
  await-text-dark: "#9096E6"
  await-tint-dark: "#25264C"
  on-await-light: "#FFFFFF"
  on-await-dark: "#15161A"
  running-text-light: "#C0722A"
  running-tint-light: "#F6EBDC"
  running-text-dark: "#DE9A45"
  running-tint-dark: "#3A2C16"
  done-text-light: "#267356"
  done-tint-light: "#E1F1EA"
  done-text-dark: "#37C48E"
  done-tint-dark: "#12302A"
  on-done-light: "#FFFFFF"
  on-done-dark: "#0E1413"
  failed-text-light: "#AF3C52"
  failed-tint-light: "#F9E4E8"
  failed-text-dark: "#F0768A"
  failed-tint-dark: "#3B1D24"
  blocked-slate-light: "#6A7079"
  blocked-tint-light: "#ECEDEA"
  blocked-slate-dark: "#8A9099"
  blocked-tint-dark: "#282B31"
  tool-text-light: "#0D7271"
  tool-tint-light: "#DDEFEE"
  tool-text-dark: "#33BDB4"
  tool-tint-dark: "#123330"
  btn-go-fill-light: "#4B4FA6"
  btn-go-fill-dark: "#5B60C2"
typography:
  hero:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.03em"
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.4375rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.09em"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "8px"
  md: "10px"
  lg: "13px"
  xl: "13px"
  pill: "999px"
  bold-sm: "3px"
  bold-md: "3px"
  bold-lg: "4px"
  bold-xl: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  "2xl": "30px"
---

# Design System: Harmonic — "Paper"

## 1. Overview

**North Star: "Paper."** Harmonic is an operator's console for running and reviewing a fleet of autonomous coding agents. The **Board** is the operator's home — the one surface that reads the whole fleet at a glance, ordered by *the operator's attention*, not by chart type. The register is a serious control-room tool rendered as a **calm, matte paper world**: a low-chroma near-neutral canvas, quiet real elevation, one teal action voice, and a small semantic state palette. It carries a lot of state in little space and never performs excitement (PRODUCT.md: "the tool disappears into the task").

**"Paper" is a register, not a picture.** No paper texture, no skeuomorphism, no costume — the name means *matte, low-chroma, tactile-but-flat, quiet*. This is the correction to any temptation to theme the tool: Paper is restrained and serious (Linear-grade / terminal-adjacent), never whimsical or metaphor-dressed.

This is a redesign, not a retheme: the UI is organised around the real lifecycle. Tickets flow `draft → ready → working → done` (the Attempt loop lands its own verified work), reach `escalated` when they need a human (ADR-0041), and Epics **merge** as a batch through an integration branch and a merge train. The old cobalt "Deck" skin, its panelled row-lists, and its kanban ancestry are gone.

**The Prime Directive — the operator's attention leads.** Every surface is ordered so the thing that needs the operator *now* is first and loudest: escalations at the top of the Board; the escalation surface (Accept / Reject with guidance / Close) as the one loud element on a Ticket. Density is a virtue here, not a risk — but density is earned by structure (grouping, hierarchy, alignment), never bought with clutter.

Both themes are first-class. **Dark is the canonical operator identity** (warm-neutral near-black `#15161A` → `#202227`, depth from lightness steps); **Light** (the matte paper world, canvas `#F1F2EF` with white panels on soft shadows) ships for bright rooms. Theme follows `prefers-color-scheme` with a manual override persisted in `localStorage` and stamped as `data-theme` on the root. A **Soft ↔ Bold** density toggle is also first-class (§ 3). Which of Light/Dark and Soft/Bold ships as the default is **still open** — do not hardcode one away.

Paper keeps rejecting PRODUCT.md's anti-references: **CI/CD console gloom** (structure + hierarchy, not a wall of widgets), **chat-app cuteness** (no avatars, no emoji status; agents are processes), **kanban-tool sprawl** (the Board is an attention queue with one escalation surface, not a project-management board).

**Key characteristics:**
- Attention-ordered surfaces: what needs the operator now is first and loudest.
- Matte, low-chroma, quiet: near-neutral grounds, quiet real elevation, generous but disciplined density.
- **Two deliberate voices** — teal for actions/tooling, indigo for the review state — over a semantic state-signal family (§ 2). No third accent.
- Monospace is reserved for **code** — file paths, branch refs, commit oids, shell commands, tool targets, session ids, inline code. Everything read as language or as a figure is sans with `tabular-nums`.
- True dual theme + Soft/Bold density, **WCAG 2.1 AA** floor in both themes (one documented amber exception, § 2 / ADR-0033).

## 2. Colours

Two voices — a **teal action accent** and an **indigo review hue** — over a low-chroma near-neutral ground and a semantic state-signal family. Every informational pairing holds WCAG AA against its documented background in its theme: text-on-tint state pills and metadata at ≥4.5:1, non-text affordances (dividers, seams, the switch off-track) at ≥3:1, in **both** themes. The one deliberate exception is the running amber (below). `web/src/index.css` + `tests/contrast.test.ts` are the implementation gate when Paper lands in the app; this file is the intent, and the mockup's in-browser WCAG sampler is the current source of truth (0 non-exception failures across Light/Dark × Soft/Bold, 2026-08-21).

### The two voices
- **Teal Accent** (`#0D7271` light / `#33BDB4` dark): the interface's action/tooling voice — primary actions, active nav, current selection, focus rings, the *ready* frontier and `Run now`, tooling/branch/epic refs, and the escalation `Accept` button. Filled buttons pair it with white in light / near-black (`#0E1413`) in dark. Hover: `#0B6360` light, `#4CD0C7` dark. **Accent Tint** (`#E0F0EF` / `#123330`): fill under active nav, the `Run now` ghost, tooling badges.
- **Indigo Escalated** (`await` `#4B4FA6` light / `#9096E6` dark): reserved for the one state that needs the operator — **escalated** pills, the **"Needs you"** section + count, the **Resolve →** button, and the **selected run chip**. **Await Tint** (`#ECEDF7` / `#25264C`): the escalated pill, the selected run row, the needs-you section header. This is the deliberate break from Deck: escalated is **not** the action accent — the state owns its own hue, so "needs you" never blurs into ordinary chrome.

**The Two Voices Rule.** Teal means *action / tooling / ready-to-run*; indigo means *the operator's turn (escalated / needs-you)*. Never use teal for the escalated state, and never use indigo for a generic action. Each voice stays ≤~10% of any screen; if either is decorating something, it's wrong.

### Neutral (low-chroma paper ground)
- **Canvas** (`#F1F2EF` / `#15161A`): the page field and the gap between panels — a matte near-neutral, faintly warm in light, warm-neutral in dark.
- **Shell** (`#FFFFFF` / `#1B1D22`): the rail (`<nav>`), the status strip (`<header>`), the ticket crumb bar.
- **Surface** (`#FFFFFF` / `#202227`): cards, bands, dialogs, the ticket sidebar.
- **Raised** (`#EEEFEB` / `#282B31`): inset fills — count pills, hovers, neutral chips.
- **Sunken** (`#FAFAF8` / `#191B1F`): recessed wells — the diff file list, the changed-files list, band-header hover. (A token, not a raw hex — the 2026-08-21 audit tokenised the last hard-coded neutrals.)
- **Field** (`#FFFFFF` / `#1B1D22`): form controls only — a surface you type *into*.
- **Hairline** (`#E6E7E2` / `#2C2F36`): shared-edge dividers and inset row-separators. **Edge** (`#D5D8D1` / `#3B3F47`): interactive borders (fields, ghost buttons, run chips). **Edge-strong** (`= Edge` light / `#454B54` dark): the dark node-hover border.
- **Ink** (`#1B1E24` / `#E8E9EC`): primary text. **Muted** (`#656B73` / `#A3A8B0`): secondary text — the informational floor, ≥4.5:1. **Faint** (`#61676F` / `#979BA2`): quiet metadata (branch names, ids, timestamps, zero counts) — held at ≥4.5:1 on every neutral background.

### State-signal family (belongs to the work, not the chrome)
Each state is a text colour + a dot colour + a tint fill, per theme, rendered as dots, tinted count pills, state pills, run-chip states, and merge-train segments:
- **Working amber** (`#C0722A` / tint `#F6EBDC` · dark `#DE9A45` / tint `#3A2C16`): work in flight — the Attempt loop is executing.
- **Escalated = indigo** (see the two voices above) — the state that needs you.
- **Ready = teal** (`#0D7271` / tint `#DDEFEE` · dark `#33BDB4` / tint `#123330`): queued to run, in the ready frontier — the same hue as the action accent, because *ready* is "actionable now."
- **Done emerald** (`#267356` / tint `#E1F1EA` · dark `#37C48E` / tint `#12302A`): verified, landed, folded. **Distinct green from teal on purpose** — never give *ready* its own separate green (two greens confused the operator; ready is teal, merged is emerald).
- **Failed rose** (`#AF3C52` / tint `#F9E4E8` · dark `#F0768A` / tint `#3B1D24`): failed, rejected, blocked member, destructive.
- **Blocked slate** (`#6A7079` / tint `#ECEDEA` · dark `#8A9099` / tint `#282B31`): waiting on a dependency. (Light slate darkened from `#868C95` in the AA retune.)
- **Tooling = teal** (`= accent`): tool calls, branch/epic refs, harness metadata, the Epic kind badge. Paper folds Deck's separate tooling-cyan into the teal voice.

### Named accessibility rules (2026-08-21 audit)
**The Ink-Flip Rule.** The white-on-solid *await* and *merged* fills fail AA in the dark theme (white on the bright periwinkle/emerald measures ~2.7 / ~2.2:1). Do **not** darken the fills — that mutes the colour. Instead the glyph ink flips per theme via `--on-await` / `--on-done`: white in light, dark ink (`#15161A` / `#0E1413`) on the bright fills in dark. Any new white-on-state-fill pairing follows this.

**The Amber Exception (ADR-0033).** The running amber measures **3.1–3.7:1** at the ~10px sizes where it appears as text — below AA. It is an *accepted, bounded* exception because running state is **never carried by colour alone**: a pulsing dot, a text label, and structural position always accompany it. The amber stays vivid; we do not chase 4.5:1 at 10px. The constraint: if amber ever becomes the *sole* carrier of a state (no dot, label, or position), that usage must meet AA independently.

**The Cool-Neutral-ish Rule.** Neutrals stay low-chroma in both themes; the little warmth in the paper ground is deliberate and quiet — all real hue comes from the two voices and the state family.

## 3. Typography

**Display / UI / Body:** system sans (`--font-display`: `ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`). No CDN font `<link>`s — character comes from scale, weight, and spacing, not an exotic face.
**Code:** JetBrains Mono (`--font-data`, `ui-monospace` fallback) — **code only**, self-hosted via `@fontsource/jetbrains-mono` (weights 400 / 600), so no external request.

Working weights: 400 body / 500–600 UI emphasis / 700–800 headings. `tabular-nums` is inherent everywhere digits appear, so numbers line up in sans without mono.

### Hierarchy
- **Hero** (800, 3.25rem/1, −0.03em): the single giant figure — the Stats headline cost number. Not used for titles.
- **Display** (800, 1.4375rem/1.2, −0.025em): the Ticket page title — the one real headline.
- **Title** (700, 0.9375rem/1.4): band titles, run headers, section labels, sidebar-card labels.
- **Body** (400, 0.875rem/1.5): prose, agent messages, UI copy. Prose caps ~72–78ch; streams and diffs may run wider.
- **Small** (400, 0.75rem/1.45): metadata lines, notes, telemetry, run-chip sublines.
- **Label** (700, 0.625rem, +0.09em, uppercase): section headers, field labels, table headers. The only uppercase.
- **Code** (mono, 0.8125rem/1.5): file paths, shell commands, branch/epic refs, commit oids, session ids, inline code.

### Named rules
**The Mono Is Code Rule.** Monospace appears *only* where the operator reads genuine code or a code-identity token. Everything read as language or a plain figure is sans with `tabular-nums` — model/harness names, costs, token counts, ordinary ids, timestamps, statuses. A whole metadata line in mono is a regression.

**The Two Number Spaces Rule.** A native Task id reads `T-<id>` in compact slots and `Task <id>` in prose/dialog titles; `#<n>` is reserved for a tracker (GitHub) issue ref. Where both meet (the Ticket header) both show: `Task 172 · issue #185`.

**The Three Weights Rule.** 400 / 500–600 / 700 (800 for the Display title). If hierarchy needs more, fix size or colour-layer, not the weight ramp.

**Soft vs Bold (density).** A first-class toggle on the root (`.bold`). **Soft** is the calm default look: rounded corners (8/10/13px), state colour on dots + bars + pills only. **Bold** sharpens every corner (3/3/4px) and washes ready/running/await/merged cards and nodes with their state tint for a denser, higher-signal read. **Bold's density is locked** — do not restyle it or run `quieter` on it (Jess: "leave as is entirely"). Which of Soft/Bold ships as default is open.

## 4. Elevation & grouping

Depth is real but quiet, **declared once per element** (never a border *and* a wide shadow — that ghost-card pairing is banned):
- **Cards, bands, dialogs — Light:** Surface fill on the canvas with a soft two-layer shadow. **Dark:** shadows fade on a dark field, so an element is a lightness step (canvas → shell → surface → raised) with a 1px hairline ring standing in for the shadow. This is the `border-color:transparent` trick: elevation is declared once — the shadow carries lift in light, the hairline ring in dark.
- **Floating elements** (dialogs): a stronger float shadow in light; in dark, a heavier shadow plus an Edge ring.
- **Cards carry a colored left accent bar** in their state's colour — a rendered `<span aria-hidden>` at `absolute inset-y-0 left-0 w-[5px]`, tinted per state via `CARD_ACCENT[state]` (Board.tsx), **not** a `::before` pseudo. This is **Jess-directed and deliberately overrides** the craft-floor "no side-stripe borders" default — the bar is the fastest state read on a scannable strip.
- The focus ring is a 2px teal outline (`outline-accent`), offset 2px, on `:focus-visible`, everywhere; the global `:focus-visible` rule in index.css sets `outline: 2px solid var(--hm-accent); outline-offset: 2px`.

**Implementation note (reconciled to `web/src/index.css` + `web/src/components`, 2026-08-24).** Paper ships as **Tailwind v4 utilities over the `@theme` tokens** in `index.css` — the primitives are `--hm-*` (light `:root`, dark `:root:not([data-theme='light'])` / `:root[data-theme='dark']`), aliased to `--color-*` via `@theme inline` and consumed as utilities (`bg-accent`, `text-ready`, `bg-ready-tint`, `border-edge`, `text-faint`, `tabular-nums`). Class-name selectors named in this file (`.card`, `.tkshell`, `.bandhd`, `.navitem`) are **illustrative structure from the mockup**, not authored CSS classes; the utilities above are the real styling hooks. Dark hover accent is `--hm-accent-hot` (`#4CD0C7`); the switch off-track is `--hm-switch-off` (`#696C73` dark).

## 5. Layout & Information Architecture

**App shell (landmarked).** A slim left **`<nav>` rail** (~224px, Shell fill, hairline right edge): the wordmark, the Workspace switcher, and primary nav grouped **Workspace** (Board / Activity / Table / Graph / Stats) and **Instance** (API / Workspace), as line-icon + label rows (active = teal text on Accent Tint; a badge carries a count, **indigo** when it's the "Needs you" count). A collapse toggle pins bottom; below ~860px the rail collapses to icons. A thin **`<header>` status strip** carries *status, not navigation* — the auto-runner switch, running count (amber dot) + machine ceiling, today's cost — then, right-aligned, the Soft/Bold toggle, the theme cycle, Settings, and the one primary action (**New task**). The working column is `<main>`; the shell is pinned and only the working area scrolls.

### The Board (home / signature surface)
Full-width, attention-ordered sections, top → bottom:
- **Needs you** — the sacred core, always first: *escalated* Tickets and Epics (indigo, with the escalation reason at a glance); non-agent-workable (human-only) tickets render muted with a distinct icon, never here. A horizontal **card strip** (fixed ~420px cards; overflow shows a right-edge fade + "→ N more" chip). Its section label + count are **indigo**, the one section that isn't faint.
- **Active** — the working Tickets, a card strip; the count matches "N working." A running Epic member shows in its Epic band, not duplicated here.
- **Epics** — collapsible **bands**; each expands to a **frontier-DAG** (below). Standalone (non-Epic) Tasks and Epic members are both first-class.
- **Standalone** — loose task cards on the canvas (not boxed in a band), their own frontier.

### The frontier-DAG (inside an Epic band)
The one place the parallel-Epic machinery is legible at a glance:
- **Column 0 = Frontier** (ready + running — actionable now), then **Depth 1..N** of blocked tasks by dependency depth. Horizontal scroll **inside** the panel; fixed ~300px node cards, never squashed to fit.
- **Ready ≠ blocked.** A node is in the Frontier only if all blockers are satisfied; otherwise it sits in a Depth column. Never show "ready" inside a depth column.
- **Merged members are hidden from the DAG entirely** (folded into the epic branch). An epic whose members all merged collapses to its merge-train + integration tip; empty columns drop out.
- **Cross-epic dependencies are chips, never drawn lines.** No connector lines at all — column position + colour carry flow. Satisfied blockers are struck-through chips.
- **Node state = the dot only** (plus an sr-only status word). No status text, no colored left bar on nodes; ready/running nodes get a subtle colored border, blocked = hairline.
- **Merge-train pips = merge PROGRESS:** one green only — green merged, amber running, neutral grey everything not-yet-merged. Never give *ready* its own green.
- Column headers terse: **Frontier / Depth 1 / Depth 2 …**

### The Ticket page (its own route)
A full-width page you navigate into. Crumb: `harmonic / Epic epic/166 / Task 172 · issue #185` (the epic crumb only when the task is in an epic). It separates **task-level** facts (constant) from **run-level** facts (per attempt):
- **Task header:** Display title + state pill; a **flat metrics row** — Cost · Tokens · Elapsed · Runs · Diff — as non-card, hairline-separated figures (never stat-cards); a meta line (origin · priority · agent · deps · notify); a clamped Brief/description with Show-more.
- **Run-centric body** (`.tkshell`): a full-height right **run rail** (`<aside>`) + a main pane that shows **Run OR Changes**, driven by the rail's selection:
  - **Run rail** holds **Run attempts** (one selectable row per attempt: dot + `Run N` + `state · cost · duration`, selected on Await Tint + indigo ring), the **Worktree** (branch ref, base, isolation), and **Changed files** (per-file M/A badge + ± stat).
  - **Run** view (an attempt selected): the attempt's **timeline rows** (rebase, implementation, each verification command, review) with command, output and verdict, the **transcript** (native harness event stream), and a **per-agent usage table** (read/write/cached bars + cost per agent). A warm/continued run names its session continuity.
  - **Changes** view (a changed file selected): the **run-agnostic worktree diff** — the cumulative diff of the worktree, not tied to any single run.
- **Escalation surface:** on an escalated ticket, exactly three actions on the escalated attempt's timeline entry — **Close (quiet destructive)**, **Reject with guidance… (ghost)**, then **Accept (teal fill, last)** — the loudest element on the page, and **sticky** so it stays reachable when the sidebar stacks below at narrow widths. Accept is disabled when no verified head exists. Every other state shows the plain state actions.

### Other surfaces
Activity, Table, Graph (dependency DAG), Stats, API, Workspace, Settings inherit the Paper system — the two voices, the state layer, the type scale, panels/cards — and are reached from the rail.

## 6. Components

### Board card (Needs you / Active / Standalone strips)
A colored **left accent bar** (state) · state dot · faint mono id (`T-<id>` native / `#<ref>` mirrored) · loud title · ≤2 quiet meta facts · a right-aligned action or signal. **Attention cards** (Needs you) put harness·model on its own line below the action-description line. Bottom-left: a git branch/worktree icon + ref (mono); bottom-right: `runtime · ctx %`. Top-left **Epic badge** (`epic/260`, teal mono) only if in an epic. Top-right **HITL badge** (person icon + "HITL", amber) — HITL cards get **no** Run-now. Right-aligned action by state: **Resolve →** (indigo, escalated), **Run now** (teal). Hover raises the card; the card is the click target to the Ticket.

### Epic band + frontier-DAG node
Band header: the **kind** badge (`Map` / `Spec`, teal tint), `epic/<ref>` (mono), the title, the **merge-train** pips, a disclosure chevron. Expands to the frontier-DAG (§ 5). A **node**: state dot + mono id + title + dependency chips (satisfied = struck-through); ready frontier nodes get a teal ▷ **Run now**; blocked nodes carry their blocker chips. Merged nodes are hidden.

### Run rail, stepper & verification
- **Run attempt row:** dot + `Run N` + `state · cost · duration`; selected on Await Tint + indigo ring.
- **Phase stepper:** `executing → validating → verifying → review → merging`. Done = emerald ✓ node (ink flips per theme), current = indigo node, pending = hollow Edge node, **failed = rose ✕** (a failed run stops there); connectors fill emerald behind completed steps.
- **Verification block:** a header verdict (proceed emerald / block·escalate rose) + one row per mechanism (Command, Critic·model) with a pass/fail icon, one-line summary, and verdict word. Fail-safe reads never render as a silent pass.
- **Per-agent usage table:** one row per agent — role (+ `subagent` tag), model, a read/write/cached stacked bar with a legend, and cost. Flat rows, hairline-separated, never cards.

### Buttons
- **Primary:** teal fill, white / near-black text, weight 600. One per surface, plus the gate's Accept.
- **Review / Go:** indigo (`btn-go`) — the review state's forward move (`Review →`), and Bold fills it solid indigo.
- **Run:** teal on Accent Tint (`btn-run` / `Run now`).
- **Ghost:** Surface fill, 1px Edge border, ink text; hover darkens the border (`Take over`, `Reject…`).
- **Escalation surface:** **Close (quiet destructive)**, **Reject with guidance… (ghost)**, then **Accept (teal, last)** — the affirmative holds the terminal position. Accept lands the verified head as-is; it refuses when the head has moved or none exists.
- **Hit targets:** every interactive control gets a ≥44×44px hit area via an overlay pseudo-element (expand the hit box, not the visual). **Hover/Focus:** ~150ms ease; 2px teal `:focus-visible` outline.

### Dialogs & tooltips
- **Native `<dialog>`** (`showModal()`): Surface fill, 13px radius, float shadow (Edge ring in dark), `::backdrop` at `rgb(0 0 0 / .42)`, explicit `margin:auto` centering, focus managed by the platform, Esc + backdrop-click close, focus restored to the invoker. Its heading is an `<h2>` (no `h1 → h3` skip).
- **Tooltips** are on-demand (`data-tip`, hover/focus), no standing chrome — the dense shorthand explains itself on demand rather than carrying permanent hint text.

### Accessibility baseline (built in, verified 2026-08-21)
Landmarks (`<nav>` / `<main>` / `<header>` / `<aside>`); **`aria-live`** regions (polite for state transitions and the live "Needs you" count, assertive for the merge outcome) — a screen-reader operator hears a ticket reach escalated; colour-only state dots carry `role="img"` + label; all decorative SVGs and separator glyphs are `aria-hidden`; icon-only controls have accessible names; `prefers-reduced-motion` drops every animation (dot pulse included) but never the figure; full keyboard paths with visible `:focus-visible`.

## 7. Do's and Don'ts

### Do
- **Do** order every surface by the operator's attention — escalations first, loudest.
- **Do** keep the **two voices** clean: teal = action / tooling / ready; indigo = the operator's turn (escalated / needs-you). Each ≤~10% of a screen.
- **Do** keep state colour on the state layer only (dot, count pill, state pill, merge-train segment, run-chip state word).
- **Do** flip glyph ink per theme on the bright await/merged fills (`--on-await` / `--on-done`) to hold AA — never darken the fill.
- **Do** set everything read as language or a figure in sans with `tabular-nums`; reserve mono for genuine code and code-identity tokens.
- **Do** declare elevation once (shadow *or* ring); floor informational text at Muted (4.5:1); design every change in both themes **and** both densities; give every control default/hover/focus-visible/disabled and every animation a reduced-motion alternative; give every control a ≥44px hit area.
- **Do** keep the card's colored left accent bar (Jess-directed) and standalone (non-Epic) Tasks first-class everywhere.
- **Do** say **merged / merging** in all UI copy.

### Don't
- **Don't** say "landing" / "landed" anywhere in the UI (code-internal `landBranch` / `EpicLandCoordinator` are unaffected).
- **Don't** use teal for the review state or indigo for a generic action; there is no third accent and no generic info-blue.
- **Don't** give *ready* its own green — ready is teal, merged is emerald; two greens confused the operator.
- **Don't** draw connector lines in the frontier-DAG (position + colour + chips carry flow), reintroduce a kanban board with drag-between-columns, or a docked master/detail Task panel.
- **Don't** set prose, labels, model/harness names, costs, ordinary ids, or telemetry in monospace; a mono metadata line is a regression.
- **Don't** darken the await/merged fills to chase AA (flip the ink), and **don't** restyle the Bold density (locked).
- **Don't** pair a border with a wide shadow (ghost-card), tint neutrals toward a hue, use gradient text, glassmorphism, nested cards, or a faux-terminal costume (scanlines, glow, CRT). Paper is matte and quiet; the "terminal" feeling is density and mono code, nothing theatrical.
