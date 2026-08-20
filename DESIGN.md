<!-- CURRENT: the "Deck" operator redesign, chosen 2026-08-19, replacing the
     "Aurora" content-first direction of 2026-07-16 (itself a restart of the
     "Ledger" of 2026-07-15 and the terminal-native "Signal Console" of
     2026-07-14). Aurora was sound in its parts (dual theme, real elevation,
     one cobalt, AA floor, the state-signal family, Mono-Is-Code) but it was
     still framed as a *premium-SaaS, content-first* console — calm floating
     cards, generous air, a kanban Board, a docked Task-detail panel. The
     ground-up brief (Jess, 2026-08-19) was to rethink the whole UI around the
     ACTUAL workflow of Tasks and Epics, as a serious operator TOOL — "no
     whimsy or costume, not just a subtle retheme."

     Deck keeps everything of Aurora's that was discipline, not costume, and
     changes four things:
       · Identity/register: dense, structural, terminal-adjacent Linear-grade —
         not premium-SaaS calm. Grouping is by floating PANELS (a panel holds a
         group of rows), not by open air alone.
       · IA of the home: the Board's kanban columns become the **Deck** — a
         full-width, attention-ordered list of panelled sections
         (Needs you → In flight → Landing → Queued → Recent). No drag-between-
         columns (agent Tasks move by executing, not by dragging). Standalone
         (non-Epic) Tasks and Epic members are BOTH first-class.
       · The ticket: the docked Task-detail panel becomes a **full Ticket page**
         you navigate into (its own route), with a task-level header and a
         **run rail** that switches between a Task's Runs (retries), each Run
         owning its own phases / verification / output / changes / cost / reason.
       · Light neutrals retuned so panels lift off the canvas (the old #FBFBFD
         canvas left white panels indistinct); dark neutrals unchanged.

     Retired with Aurora: the calm-sky metaphor and the "content leads, cut
     until calm" framing as the prime directive — density is now a virtue, not
     a risk to manage. Where running code and this file disagree, this file
     wins for new work. The approved visual reference is `.scratch/redesign/
     deck.html` (Deck + Ticket, both themes). -->

---
name: Harmonic
description: Operator console for running and reviewing autonomous coding agents — dense, structural, terminal-adjacent; workflow-shaped surfaces, signal-colour state
designSystem: Deck
colors:
  accent: "#2563EB"
  accent-dark: "#6E8BFF"
  accent-hover: "#1D4FD8"
  accent-hover-dark: "#8AA1FF"
  accent-tint-light: "#EAF1FE"
  accent-tint-dark: "#1C2545"
  on-accent-light: "#FFFFFF"
  on-accent-dark: "#0E1016"
  canvas-light: "#F6F7FB"
  canvas-dark: "#0E1016"
  shell-light: "#FFFFFF"
  shell-dark: "#14161D"
  surface-light: "#FFFFFF"
  surface-dark: "#171A22"
  raised-light: "#EEF0F6"
  raised-dark: "#1F232D"
  hairline-light: "#E7E9F1"
  hairline-dark: "#242A35"
  edge-light: "#D6D9E4"
  edge-dark: "#2E3440"
  switch-off-light: "#8B8D9C"
  switch-off-dark: "#666980"
  ink-light: "#141627"
  ink-dark: "#EDEFF6"
  muted-light: "#565A72"
  muted-dark: "#9BA0B5"
  faint-light: "#767A8E"
  faint-dark: "#7E8496"
  running-text-light: "#A45606"
  running-dot-light: "#E08A0E"
  running-tint-light: "#FBEFD8"
  running-text-dark: "#F0A93A"
  running-tint-dark: "#3A2C12"
  ready-text-light: "#14793A"
  ready-dot-light: "#1BA35B"
  ready-tint-light: "#DAF4E4"
  ready-dot-dark: "#34D399"
  ready-tint-dark: "#123026"
  completed-text-light: "#067A55"
  completed-dot-light: "#10B981"
  completed-tint-light: "#D6F5E7"
  completed-text-dark: "#34D399"
  completed-tint-dark: "#123026"
  failed-text-light: "#B9354B"
  failed-dot-light: "#F0576E"
  failed-tint-light: "#FDE3E8"
  failed-text-dark: "#FB7185"
  failed-tint-dark: "#3A1720"
  blocked-slate-light: "#64687E"
  blocked-tint-light: "#EDEEF3"
  blocked-slate-dark: "#8A90A6"
  blocked-tint-dark: "#22262F"
  tool-text-light: "#0C7486"
  tool-dot-light: "#16A6BE"
  tool-tint-light: "#DAF3F8"
  tool-text-dark: "#38BDF8"
  tool-tint-dark: "#10303B"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.4375rem"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  hero:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 750
    letterSpacing: "-0.03em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
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
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 700
    letterSpacing: "0.09em"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "7px"
  md: "8px"
  lg: "11px"
  xl: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  "2xl": "32px"
---

# Design System: Harmonic — "Deck"

## 1. Overview

**North Star: "Deck."** Harmonic is an operator's console for running and reviewing a fleet of autonomous coding agents. The Deck is the operator's board — the one surface that reads the whole fleet at a glance and is ordered by *the operator's attention*, not by chart type. The register is a serious control-room tool: **dense, structural, terminal-adjacent, Linear-grade.** It carries a lot of state in little space, speaks in one cobalt accent over a semantic state palette, and never performs excitement (PRODUCT.md: "the tool disappears into the task"). No metaphor, no costume, no decoration that doesn't convey state.

This is a redesign, not a retheme: the UI is reorganised around the real lifecycle — Tasks flow `draft → ready → running → verifying → review → landed`, escalate `afk→hitl` when they need a human, and Epics land as a batch through an integration branch and a merge train. The old kanban Board and docked detail panel are gone.

**The Prime Directive — the operator's attention leads.** Every surface is ordered so the thing that needs the operator *now* is first and loudest: the review gate and escalations at the top of the Deck; the review gate as the one loud element on a Ticket. Density is a virtue here, not a risk — but density is earned by structure (grouping, hierarchy, alignment), never bought with clutter. If a surface reads as busy, the failure is missing structure, not too much information; add grouping before you cut content.

**Grouping is by panel.** A related set of rows lives inside a floating **panel** (Surface fill, soft real shadow in light, a lightness-step + hairline in dark). Panels separate groups from each other by the canvas showing between them; rows inside a panel separate by a hairline inset from the panel's edges. This is the correction to two past failures at once: the Ledger drowned content in ruled rows and mono; Aurora over-corrected into calm floating cards and open air that read as under-structured on a dense operator surface. The Deck groups with panels and carries density with alignment.

Both themes are first-class. **Dark is the canonical operator identity** (cool near-black #0E1016 → #171A22, depth from lightness steps); **Light** ships for bright rooms (cool near-white #F6F7FB canvas with white panels on soft shadows). Theme follows `prefers-color-scheme` with a manual override (System → Light → Dark) persisted in `localStorage` and stamped as `data-theme` on the root.

Deck keeps rejecting PRODUCT.md's anti-references: **CI/CD console gloom** (panels + hierarchy, not a wall of widgets), **chat-app cuteness** (no avatars, no emoji status; agents are processes), **kanban-tool sprawl** (the Deck is an attention queue with a review gate, not a project-management board).

**Key characteristics:**
- Attention-ordered surfaces: what needs the operator now is first and loudest.
- Dense and structural: grouping by panels, hierarchy by weight/size/colour-layer, alignment carries a lot of state per pixel.
- One cobalt accent (the interface's voice, ≤10% of any screen) + a semantic state-signal family (the work's colours).
- Monospace is reserved for **code** — file paths, branch refs, commit oids, shell commands, tool targets, inline code. Everything read as language or as a figure is sans with `tabular-nums`.
- Terminal-adjacent, never a costume: no scanlines, no glow, no faux-CRT; the "terminal" feeling comes from density, mono code, and restraint.
- True dual theme, AA contrast floor in both.

## 2. Colours

One cobalt accent, a cool-neutral ground, and a semantic state-signal family. Every informational pairing holds WCAG AA against its documented background in its theme — text-on-tint state pills at ≥4.5:1, the Faint role at ≥4.5:1 where it labels metadata, and non-text affordances (the Switch off-track, dividers, seams) at ≥3:1 — in **both** themes. `tests/contrast.test.ts` computes every documented pairing from `web/src/index.css` and fails the build if any drops below its floor (issue #87). **The retuned light neutrals (canvas/raised/hairline/edge) and any new tint pairing introduced by the Deck redesign must be re-verified against that test before they ship — the test is the gate, this file is the intent.**

### Accent (the interface's one voice)
- **Cobalt Accent** (#2563EB light / #6E8BFF dark): primary actions, active nav, current selection, focus rings, the chart series, the run-rail's selected chip, and the *awaiting-review* state (the state that needs the operator is deliberately the accent). Filled buttons pair it with white in light / near-black (#0E1016) in dark. Hover: #1D4FD8 light, #8AA1FF dark.
- **Accent Tint** (#EAF1FE / #1C2545): fill under active nav, the selected run chip, the operator's own chat message, the *awaiting-review* pill. The light tint holds AA under the accent text it carries.

### Neutral (cool near-zero-chroma ground)
- **Canvas** (#F6F7FB / #0E1016): the page field, and the gap between panels. Light is darkened from Aurora's #FBFBFD so white panels lift off it — the fix for "light reads indistinct."
- **Shell** (#FFFFFF / #14161D): the rail, the status strip, the ticket crumb bar.
- **Surface** (#FFFFFF / #171A22): panels, cards, dialogs.
- **Raised** (#EEF0F6 / #1F232D): inset fills — count pills, hovers, neutral chips.
- **Field** (#FFFFFF / #14161D): form controls only — read as a surface you type *into*. See `--hm-field` in `web/src/index.css`.
- **Hairline** (#E7E9F1 / #242A35): shared-edge dividers and the inset row-separators *inside* a panel. **Edge** (#D6D9E4 / #2E3440): interactive borders (fields, ghost buttons, run chips). **Switch off-track** (#8B8D9C / #666980): pitched dark enough to hold ≥3:1 against both the white knob and the surface behind it.
- **Ink** (#141627 / #EDEFF6): primary text. **Muted** (#565A72 / #9BA0B5): secondary text — the informational floor, ≥4.5:1. **Faint** (#767A8E / #7E8496): icon-only affordances, disabled text, and quiet metadata lines (branch names, ids, timestamps, zero counts, the dialog close ✕) — held at ≥4.5:1 on every neutral background.

### State-signal family (belongs to the work, not the chrome)
Each state is a text colour + a dot colour + a tint fill, per theme, rendered as dots, tinted count pills, state pills, and run-rail chip states:
- **Running amber** (#A45606 / dot #E08A0E / tint #FBEFD8 · dark #F0A93A / tint #3A2C12): work in flight; also the escalation/attention register (see the Signal Rule carve-outs).
- **Ready green** (#14793A / dot #1BA35B / tint #DAF4E4 · dark dot #34D399 / tint #123026): queued to run, in the ready frontier.
- **Awaiting review = the cobalt accent** (it needs you — it's the accent, not a separate hue).
- **Blocked slate** (#64687E / tint #EDEEF3 · dark #8A90A6 / tint #22262F): waiting on a dependency.
- **Completed emerald** (#067A55 / dot #10B981 / tint #D6F5E7 · dark #34D399 / tint #123026): finished, accepted, folded.
- **Failed rose** (#B9354B / dot #F0576E / tint #FDE3E8 · dark #FB7185 / tint #3A1720): failed, rejected, blocked member, destructive.
- **Tooling cyan** (#0C7486 / dot #16A6BE / tint #DAF3F8 · dark #38BDF8 / tint #10303B): tool calls, branch/epic refs, harness metadata, the Epic kind badge.
- **Draft** is neutral (Muted/Faint) — nothing is happening yet. Priority is typographic (a quiet Raised chip + weight), never a hue.

### Named rules
**The One Cobalt Rule.** The accent appears on at most ~10% of any screen: primary action, active nav, selection, focus, the chart, the selected run chip, and the awaiting-review state. If cobalt is decorating something, it's wrong.

**The Signal Rule.** State colours mean states and live on the **state/signal layer** — a dot, a count pill, a state pill, a merge-train segment, a run-rail chip's state word — never smeared across content, never decorative. A colour the operator can't parse as a state is noise. Carve-outs (all retained): the API reference reuses the tints as a redundant second cue on HTTP-method / response-code pills; a mirrored Task's `escalated` tag reuses Running amber's tint/ink on every surface it appears (issue #34, #99), an afk→hitl escalation being "work in flight, now yours"; the reject dialog's continuation-cost chip colours only the *pricier* re-attempt path in Running amber, as harness-attention chrome, never a task state (issues #175, #177).

**The Cool-Neutral Rule.** Neutrals carry no hue in either theme; warmth or coolness comes only from the accent and the state family.

## 3. Typography

**Display / UI / Body:** system sans (ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto). Character comes from a deliberate scale, weight, and spacing — not an exotic face.
**Code:** JetBrains Mono (ui-monospace fallback) — **code only.**

Three working weights: 400 body / 500–550 UI emphasis / 650–750 headings. `tabular-nums` is inherent everywhere digits appear, so numbers line up in sans without needing mono.

### Hierarchy
- **Display** (750, ~1.44rem, −0.025em): the Ticket page title — the one place a real headline earns its size.
- **Hero** (750, ~3.25rem, −0.03em): the single big figure on Stats (cost). Rare.
- **Title** (600, 0.9375rem): panel and section-card headings, the Ticket sidebar card labels.
- **Body** (400, 0.875rem/1.5): prose, agent messages, UI copy. Prose caps at ~72ch; streams and tables may run wider.
- **Small** (0.75rem): metadata lines, notes, telemetry, run-chip sublines.
- **Label** (700, 0.625rem, +0.09em, uppercase): section headers, field labels, sidebar-card labels, table headers. The only uppercase in the system.
- **Code** (mono, 0.8125rem): file paths, shell commands, branch/epic refs, commit oids, tool targets, session ids, inline code tokens.

### Named rules
**The Mono Is Code Rule.** Monospace appears *only* where the operator reads genuine code or a code-identity token: file paths, shell commands, branch/epic refs, commit oids, tool-call targets, session ids, inline code. **Everything read as language or as a plain figure is sans** — model names, harness names, costs, token counts, ordinary Task ids, timestamps, statuses, telemetry — all sans with `tabular-nums`. A whole metadata line in mono is a regression (the Ledger's core mistake). Run-event timestamps beside code stay mono only where they read as log lines within a stream; a standalone timestamp is sans.

**The Two Number Spaces Rule.** A task id and a tracker issue ref are different number spaces that collide as integers. A task id is never a bare `#n` — it reads `T-<id>` in compact slots (Deck rows, graph nodes, table cells) and `Task <id>` in prose and dialog titles; `#<n>` is reserved for a tracker (GitHub) issue ref, GitHub's own convention. Where both meet (the Ticket header) both show, disambiguated: `Task 174 · issue #185` (issue #192). The single formatter is `web/src/id-format.ts`.

**The Three Weights Rule.** 400 / 500–550 / 650 (750 for the Display title). If hierarchy needs more, fix the size or the colour layer, not the weight ramp.

## 4. Elevation & grouping

Depth is real but quiet, declared once per element (never a border *and* a wide shadow — that ghost-card pairing is banned):
- **Panels & cards — Light:** Surface fill on the canvas with a soft two-layer shadow (`0 1px 2px rgb(20 22 45 / .06), 0 6px 18px rgb(20 22 45 / .07)`). **Dark:** shadows fade on a dark field, so a panel is a lightness step (canvas #0E1016 → shell #14161D → surface #171A22 → raised #1F232D) with a 1px hairline ring standing in for the shadow.
- **Floating elements** (dialogs, the review gate bar, the conversation dock, toasts): a stronger float shadow in light; in dark, a heavier shadow plus an Edge ring so they still separate.
- **Grouping is the panel, not the rule.** A group of rows lives in one panel; groups separate by the canvas between panels. *Inside* a panel, rows may carry a hairline inset from the edges as a secondary separator — this is a list within a container, not the Ledger's ruled-rows-as-sole-structure. Never build a group out of bare `divide-y`/`border-t` rows on the canvas with no panel around them.
- The focus ring is a 2px cobalt outline, offset 2px, on `:focus-visible`, everywhere.

## 5. Layout & Information Architecture

**App shell.** A slim left **rail** (~208px, Shell fill, hairline right edge): the wordmark, the Workspace switcher, and primary nav grouped **Workspace** (Deck / Activity / Table / Graph / Stats) and **Instance** (API / Workspace), as minimal line-icon + label rows (active = accent text on Accent Tint; a badge carries a count, cobalt when it's the "Needs you" count). A collapse toggle pins bottom; below ~900px the rail collapses to icons. A thin **status strip** across the top of the working area carries *status, not navigation* — the auto-runner master switch, running count (amber dot) + machine ceiling, today's cost — then, right-aligned, the theme-cycle, the global **Settings** icon (ADR 0012), Log out, and the one primary action (**New task**). The **shell is pinned; only the working area scrolls** — the rail and strip hold at every scroll position, and floating elements inset off the below-strip region rather than hardcoding its moving edge.

### The Deck (home / signature surface)
The Deck replaces the kanban Board. It is **full-width, a single centered column (~860px max)** of panelled sections, ordered by attention, not by state-columns:
- **Needs you** — the sacred core, always first: *awaiting-review* Tasks (with an at-a-glance verification verdict) and *escalated* Tasks (amber). Nothing that needs the operator is ever below the fold of this section.
- **In flight** — running Runs, with a live phase pill (executing / validating / verifying) and elapsed; standalone Tasks only (an Epic member that is running shows inside its Epic band, not duplicated here).
- **Landing** — each active **Epic** as one panel/band (see § 6): the merge-train segments, folded count, integration tip, whole-Epic verification, the blocking member, and Force-land. Collapsed by default to its status line; expands to the member roster.
- **Queued** — the ready frontier + blocked Tasks, standalone Tasks first-class (native and mirrored), with the auto-runner's pick order implied and a `Run now` on each.
- **Recent** — landed / failed today, collapsed to a count.

**Standalone (non-Epic) work is first-class everywhere.** The Deck is not Epic-shaped: a native Task or an Epic-less mirrored issue is a plain row in its attention section, never demoted because it has no Epic. Epics are an additional grouping in the Landing section, not the organising axis.

**No drag-between-columns.** Agent Tasks change state by executing, not by being dragged; the Deck row carries its state's forward action as a button (`Run now`, `Take over`, `Force-land`, `Open`). Editing happens on the Ticket, never by drop.

**Rows are the summary.** A Deck row is one glanceable line: a state dot, the id (faint mono — a native Task reads `T-<id>`, a mirrored one its tracker issue `#<ref>`), the title (loud), at most two quiet facts (harness·model, or an escalation reason), and a right-aligned signal (phase pill, verdict, or the state's action). Clicking a row opens the full Ticket — the Deck never tries to be the detail.

### The Ticket page (its own route)
Reviewing a Task, or reading a Run in full, is a **full-width page you navigate into** (crumb: `Deck / Task 172 · issue #185` for a mirrored Task showing both identities; a native Task shows just `Deck / Task 172`, with a back control), not a docked panel. It separates **task-level** facts (constant) from **run-level** facts (per attempt):
- **Task-level header:** Display title + state chip; one meta line (origin · priority · isolation · base branch · dependencies-met · notify); a **Brief** panel holding the prompt (Markdown for mirrored issues, plain for native).
- **Run rail:** a row of run chips — `✗ Run 1 failed · ⟲ Run 2 rejected · ● Run 3 awaiting` — each showing state + cost + duration, selected chip on Accent Tint. Selecting a run switches the whole detail below; a note names session continuity ("Run 3 continued Run 2's session · warm").
- **Run-level detail** (per selected run): a phase stepper for *this* run (a failed run stops with a rose ✗ at the phase it died in); a two-column body — **main** (underline tabs Output / Changes) and a **sidebar** (Verification card, then a This-run card: session warmth, usage, cost-by-model). A historical run leads with a result banner (failed: reason; rejected: reason + the feedback carried forward) and is read-only.
- **Bottom bar:** on the *current* run it is the **review gate** (§ 6) — the loudest element; on a historical run it is a quiet read-only result bar ("Run 2 rejected · superseded by Run 3 · Go to current run"). The gate arms only on the current run so a stale run can never be accepted.

### Other surfaces
Activity (instance-wide live processes), Table, Graph (dependency DAG), Stats, API, Workspace, Settings inherit the Deck system — panels, rows, the state layer, the type scale — and are reached from the rail. Their content-ranking is unchanged from prior intent: Stats leads with the hero figure + chart; Settings groups controls by air within section cards; Activity is a live tabular readout with real table semantics.

## 6. Components

### The Deck row
State dot · faint mono id · loud title · ≤2 quiet meta facts · right-aligned signal (phase pill / verdict / action button / `when`). One line of content plus one quiet meta line; never a slab of chips. Hover raises the row within its panel; the whole row is the click target to the Ticket. Escalated and mirrored get their one meaningful chip (amber `escalated`, cyan `mirrored`/`epic ref`, neutral `afk`/`high`); native/normal carry none (the absence is the default).

### Panel & section header
A **section** is an uppercase Label header (`Needs you`, count, optional right-aligned sub) above one **panel** (Surface, 12px radius, elevation per § 4). The "Needs you" header is the one section whose label is accent, not faint.

### Epic band (Landing)
One panel per Epic. Header: the **kind** badge (`Spec`/`Map`, cyan tint), the `epic/<ref>` (mono), the title, a disclosure chevron. Status row: the **merge-train** — a segment per member coloured by land status (done emerald / running amber / blocked rose / pending neutral) — then folded count, integration tip oid (mono), whole-Epic verification glyph, and, right-aligned, the blocking-member note (rose tint) + **Force-land subset**. Collapsed by default; expanding reveals member rows (each a Deck row, indented, deep-linking to the member's Ticket). This is the one place the parallel-Epic machinery (integration branch, ready frontier, merge train, land gate — ADR 0024/0026) is legible at a glance.

### Run rail & run chip
A horizontal, wrapping row of run chips at the top of the Ticket's run-level area. A chip: a state dot + `Run N` (Ink, 650), and a subline of `state · cost · duration` (state word in its colour: rose failed, amber rejected, accent awaiting, emerald completed). Selected chip = Accent Tint + a 1.5px cobalt ring. Scales to many retries by wrapping. A note below the rail states session reuse/warmth for the current run.

### Phase stepper
The Run's `executing → validating → verifying → review → landing` machine as a compact horizontal stepper: a done step is an emerald ✓ node, the current step a cobalt node, a pending step a hollow Edge node, a **failed** step a rose ✗ node (a failed Run stops there). Connectors fill emerald behind completed steps. Distinct from the Run's terminal state — a native Run is `state:running` while parked in `phase:review`.

### Verification card (Ticket sidebar)
Header: `Verification` label + the combined outcome (proceed emerald / block·escalate rose / not-reached faint). One row per mechanism (Command, Critic·model) with a pass/fail icon, a one-line summary, and a verdict word; a "N attempts · M self-heal" affordance for the full log. Fail-safe reads (inconclusive → escalate) never render as a silent pass.

### Buttons
- **Primary:** cobalt fill, white/near-black text, 8px radius, weight 600. One per surface (plus the review gate's Accept).
- **Ghost:** Surface fill, 1px Edge border, ink text; hover darkens the border. The state's forward move (`Run now`, `Take over`, `Re-attempt`) and the run rail's `Go to current run`.
- **Quiet:** Muted text link, weight 500, hover to Ink; destructive-quiet hovers to Failed rose.
- **Solid destructive:** Failed-rose fill, on-fail label — reserved for the confirm *inside* a deliberate guard (type-the-name Workspace delete). Casual destructive stays Quiet so the loud red never becomes ambient. `--hm-on-fail` clears the text floor in both themes (`tests/contrast.test.ts`).
- **Review gate:** two verbs, **Reject… (Ghost)** then **Accept & merge (cobalt, last)** — the affirmative holds the terminal position; nothing else belongs in the row. Accept is unguarded when the Verification verdict is *proceed*/absent, but **arms into a two-step confirm** ("Critic flagged — accept anyway?") when the verdict is *block*/*escalate* — a guard on overriding a red machine verdict, not on the review itself; the bar inlines the one-line verdict so the signal sits where Accept is clicked (issue #174, `TaskActions.tsx`).
- **Cancel is not a gate action.** Once a Run has produced something to judge, *cancelled* and *failed* are one terminal fact; Cancel keeps meaning only pre-result (Draft/Blocked/Ready) or while running (an armed two-step button). No drag-to-cancel a Running Task.
- **Hover/Focus:** 150ms ease-out; 2px cobalt `:focus-visible` outline. **Disabled:** 50% opacity.

### Chips, dots & pills (the state layer)
- **State dot:** a 7–8px dot in the state's colour — the lightest state signal, before a row title or a run-chip label. Running dots pulse (reduced-motion drops the pulse, never the figure).
- **Count / state pill:** count or state text in its colour on its ~15% tint. Small (10–11px, weight 600–700).
- **Merge-train segment:** a member's land status as a coloured bar segment — the Epic's colour lives here.
- Metadata is one truncating line, never a slab of chips — except the mirrored card's role-badge row (drive/type/escalated) and the run chip's own state subline.

### Conversation (docked panel)
Full-height right-hand dock (insets off the below-strip region), a sibling to Task, never queued or reviewed. Header: title + rename + id + an "Active" dot; **telemetry is ONE quiet inline line** (`273.7K tokens · $0.38 · 41% context`), never a grid. Transcript is the content: operator message as a small right-aligned Accent-Tint bubble, agent prose in sans, folded tool lines quiet, a **permission prompt** as the one prominent element (amber-tint band — the harness is blocked — with Allow once / Allow always / Reject). Composer: a calm textarea + Send.

### Stats & Settings
- **Stats:** the Hero cost figure leads (no card-in-a-card) with a quiet stat row; a single-cobalt cost-per-day chart (2px line, soft area, faint grid, honest `≥` floor for partial days); a calm table below (state pills, tabular-nums, sparse hairline dividers).
- **Settings:** section cards (Defaults / Harnesses / Notifications) grouped by air, ~22px padding, disclosure rows for harnesses; a **floating save bar** pins on dirty state (Discard / Save changes).

### Dialogs & Toasts
- Native `<dialog>`, Surface fill, 11–12px radius, float shadow (Edge ring in dark), backdrop `rgb(0 0 0 / 0.5)`, 150ms fade/scale with a reduced-motion instant alternative. One **X**, top-right, owned by `Modal` (Faint, hover Ink); a footer carries only outcomes — no "Close", no dismiss-meaning "Cancel", no second ✕.
- A rejected operation never uses native `alert()`/`confirm()` — it announces in a top-right stack of Failed-tint toast cards (`aria-live`, Dismiss, ~6s auto-dismiss, `motion-safe` descend). A completed gate action drops a **neutral** acknowledgement card (Raised, ink, muted check — `Task #12 cancelled`), not accept-green, since an acknowledgement is not a state. The stack dodges an open Conversation dock. See `web/src/toast.tsx`.

## 7. Do's and Don'ts

### Do
- **Do** order every surface by the operator's attention — the review gate and escalations first, loudest.
- **Do** group with panels; carry density with hierarchy and alignment, not clutter. If it reads busy, add structure before cutting content.
- **Do** hold the One Cobalt Rule (≤10%: primary action, active nav, selection, focus, chart, selected run chip, awaiting-review) and the Signal Rule (state colour only on the state layer).
- **Do** set everything read as language or a figure in sans with `tabular-nums`; reserve mono for genuine code and code-identity tokens (Mono Is Code).
- **Do** declare elevation once (shadow *or* ring, never both); floor informational text at Muted (4.5:1); design every change in both themes; give every control default/hover/focus-visible/disabled and every animation a `prefers-reduced-motion` alternative.
- **Do** give every interactive control a ≥44×44px hit area (expand the hit box, not necessarily the visual — `touchTarget`/`touchTargetInline`/`touchOverlay`), and give tabular readouts real table semantics with sr-only value labels.
- **Do** keep standalone (non-Epic) Tasks first-class on every surface; keep the Deck row a summary and the Ticket page the detail.

### Don't
- **Don't** reintroduce a kanban Board with drag-between-columns, or a docked master/detail Task panel — the Deck is attention-ordered rows and the Ticket is its own page.
- **Don't** carry a group's structure with bare ruled rows on the canvas (`divide-y`/`border-t` with no panel) — that was the Ledger's regression; group with a panel.
- **Don't** set prose, labels, model/harness names, costs, ordinary ids, or telemetry in monospace; a mono metadata line is a regression.
- **Don't** use state colours decoratively or smear them across content; don't pair a border with a wide shadow (ghost-card), tint neutrals toward any hue, use gradient text, glassmorphism, side-stripe borders, or nested cards.
- **Don't** let cobalt mean anything but the interface's voice — tooling metadata is cyan, there is no generic info blue, and no second accent exists.
- **Don't** dress the tool as a terminal costume (scanlines, glow, faux-CRT, rotated rails) — the terminal register is density, mono code, and restraint, nothing theatrical. The Ledger, the Signal Console, and Aurora's calm-card premium-SaaS framing are all retired.
