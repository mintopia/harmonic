<!-- CURRENT: the "Aurora" content-first redesign, chosen 2026-07-16, replacing
     the "Ledger" premium-SaaS direction of 2026-07-15 (itself a restart of the
     terminal-native "Signal Console" of 2026-07-14). The Ledger executed its
     own Stripe-lane goal as a literal ledger — ruled rows, mono-heavy, cramped —
     so content drowned in chrome. Aurora keeps the parts that were sound (dual
     theme, real elevation, one accent, AA floor) and fixes what wasn't: content
     leads, structure is carried by air not rules, monospace is reserved for code
     (not merely "data"), and colour lives on the state layer as signal.
     Design decisions vs the retired Ledger code, all chosen 2026-07-16:
       · accent moves indigo (#5851e0) → cobalt (#2563EB / #6E8BFF dark)
       · display face is now system sans; Space Grotesk is retired
       · the "Mono Is Data Rule" is tightened to the "Mono Is Code Rule"
       · a richer state-signal family (adds Ready green, Blocked slate)
     Where running code and this file disagree, this file wins for new work. -->

---
name: Harmonic
description: Premium-SaaS operator console for running and reviewing autonomous coding agents — content-first, calm surfaces, signal-colour state
designSystem: Aurora
colors:
  accent: "#2563EB"
  accent-dark: "#6E8BFF"
  accent-hover: "#1D4FD8"
  accent-hover-dark: "#8AA1FF"
  accent-tint-light: "#F0F5FE"
  accent-tint-dark: "#1B2340"
  on-accent-light: "#FFFFFF"
  on-accent-dark: "#0E1016"
  canvas-light: "#FBFBFD"
  canvas-dark: "#0E1016"
  shell-light: "#FFFFFF"
  shell-dark: "#14161D"
  surface-light: "#FFFFFF"
  surface-dark: "#171A22"
  raised-light: "#F1F2F6"
  raised-dark: "#1F232D"
  hairline-light: "#ECEDF3"
  hairline-dark: "#232833"
  edge-light: "#DDDFEA"
  edge-dark: "#2A2F3B"
  switch-off-light: "#8B8D9C"
  switch-off-dark: "#666980"
  ink-light: "#16182B"
  ink-dark: "#EBEDF5"
  muted-light: "#5A5E78"
  muted-dark: "#9BA0B5"
  faint-light: "#6A6C80"
  faint-dark: "#858B9B"
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
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
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
    fontSize: "0.90625rem"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    letterSpacing: "0.05em"
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "7px"
  md: "9px"
  lg: "12px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
---

# Design System: Harmonic — "Aurora"

## 1. Overview

**Creative North Star: "Aurora"**

Harmonic is a premium-SaaS operator console for running and reviewing autonomous coding agents. Aurora is the calm-sky metaphor: **quiet neutral surfaces are the sky; the work's state is the aurora** — bands of signal colour (running amber, ready green, awaiting cobalt, blocked slate, completed emerald, failed rose, tooling cyan) laid over a still ground. Colour means something and lives on the *state layer*; the content underneath stays calm. One cobalt is the only voice the interface itself speaks.

The register is product (PRODUCT.md: "fast, dense, operator-grade… the tool disappears into the task"), built for a side-monitor glance. But Aurora corrects the Ledger's mistake: **density is not clutter.** The Ledger carried structure with ruled rows and set nearly everything in monospace, so the actual content — the tasks, the run, the message — drowned. Aurora's prime directive is the opposite.

**The Prime Directive — Content Leads.** On every screen the thing the operator came for is the loudest element; metadata, telemetry, ids, and chrome are whispered. Whitespace and elevation carry grouping, not borders and fills. Every element earns its place or is cut. If a screen feels busy, cut more.

Both themes are first-class. **Light** is a cool near-white sky (#FBFBFD) with white cards on soft real shadows; **dark** is the same product on cool near-black surfaces (#0E1016 → #171A22) where depth comes from lightness steps. Theme follows `prefers-color-scheme` with a manual override (System → Light → Dark) persisted in `localStorage` and stamped as `data-theme` on the root.

Aurora keeps rejecting PRODUCT.md's anti-references: **CI/CD console gloom** (cards and air, not wall-of-widgets), **chat-app cuteness** (no avatars, no emoji status; agents are processes), and **kanban-tool sprawl** (the board is a queue with a review gate).

**Key characteristics:**
- Content-first hierarchy: content loud, metadata/telemetry whispered
- Calm neutral surfaces; colour is a signal on the state layer, never decoration
- One cobalt accent (the interface's voice, ≤10% of any screen) + a semantic state-signal family (the work's colours)
- Monospace is reserved for **code**, not merely "data" — sans (with tabular figures) carries everything the operator reads as language
- Structure by air + elevation; hairlines mark shared edges, never ruled rows
- True dual theme, AA contrast floor in both

## 2. Colours: The Aurora Palette

A cool-neutral sky, one cobalt accent, and a semantic state-signal family. Every informational pairing holds WCAG AA against its documented background in its theme — text-on-tint state pills at ≥4.5:1, the Faint role at ≥4.5:1 where it labels metadata, and non-text affordances (the Switch off-track, the neutral lane rules) at ≥3:1 — in **both** themes. `tests/contrast.test.ts` computes every documented pairing from `web/src/index.css` and fails the build if any drops below its floor (issue #87).

### Accent (the interface's one voice)
- **Cobalt Accent** (#2563EB light / #6E8BFF dark): primary actions, active nav, current selection, focus rings, the chart series, and the *awaiting-review* state (the state that needs the operator is deliberately the accent). Filled buttons pair it with white in light / near-black (#0E1016) in dark. Hover: #1D4FD8 light, #8AA1FF dark.
- **Accent Tint** (#F0F5FE / #1B2340): fill under active nav, selected pills, the operator's own chat message. The light tint holds AA under the accent text it carries (awaiting-review, active nav).

### Neutral (cool near-zero-chroma sky)
- **Canvas** (#FBFBFD / #0E1016): the page field.
- **Shell** (#FFFFFF / #14161D): sidebar and status strip.
- **Surface** (#FFFFFF / #171A22): cards and dialogs.
- **Raised** (#F1F2F6 / #1F232D): inset fills — count pills, hovers, the finished panel.
- **Field** (#FFFFFF / #14161D): form controls only. (Corrected 2026-07-17: Raised's line used to claim form fields too, but fields have always had their own token — they read as surfaces you type *into*, so light mode lifts them above the Raised grey rather than sinking them into it, and dark mode sinks them below it. See `--hm-field` in `web/src/index.css` and the shared `field` class in `web/src/ui.ts`.)
- **Hairline** (#ECEDF3 / #232833): shared-edge dividers only. **Edge** (#DDDFEA / #2A2F3B): interactive borders (fields, ghost buttons). **Switch off-track** (#8B8D9C / #666980): the one control neutral pitched dark enough to hold ≥3:1 against both the white knob and the card behind it.
- **Ink** (#16182B / #EBEDF5): primary text. **Muted** (#5A5E78 / #9BA0B5): secondary text — the informational floor, ≥4.5:1. **Faint** (#6A6C80 / #858B9B): icon-only affordances, disabled text, and quiet metadata lines exclusively — held at ≥4.5:1 on every neutral background (surface, canvas, raised), since it carries readable labels (branch names, ids, zero counts, the dialog close ✕).

### State-signal family (the aurora — belongs to the work, not the chrome)
Each state is a text colour + a dot colour + a tint fill, per theme, rendered as dots, tinted count pills, and state pills:
- **Running amber** (#A45606 / dot #E08A0E / tint #FBEFD8 · dark #F0A93A / tint #3A2C12): work in flight.
- **Ready green** (#14793A / dot #1BA35B / tint #DAF4E4 · dark dot #34D399 / tint #123026): queued to run.
- **Awaiting review = the cobalt accent** (it needs you — it's the accent, not a separate hue).
- **Blocked slate** (#64687E / tint #EDEEF3 · dark #8A90A6 / tint #22262F): waiting on a dependency.
- **Completed emerald** (#067A55 / dot #10B981 / tint #D6F5E7 · dark #34D399 / tint #123026): finished, accepted.
- **Failed rose** (#B9354B / dot #F0576E / tint #FDE3E8 · dark #FB7185 / tint #3A1720): failed, rejected, destructive.
- **Tooling cyan** (#0C7486 / dot #16A6BE / tint #DAF3F8 · dark #38BDF8 / tint #10303B): tool calls, branches, harness metadata.
- **Draft** is neutral (Muted/Faint) — nothing is happening yet. Priority is typographic (ink + weight), never a hue. (Amended 2026-07-17: this line used to contradict itself, adding "a HIGH flag borrows the Failed rose text only as a small label" straight after "never a hue". The code never did it, and shouldn't: rose means *failed*, and a HIGH task hasn't failed. Spending a state colour on something that isn't a state is the same mistake the retired accept-tint/fail-tint gate made — see § Elevation and `web/src/ui.ts`.)

*Tuning note (open):* Ready is the one "waiting" state given a colour; it may read neutral instead if the board feels too green. Draft stays neutral either way.

### Named rules
**The One Cobalt Rule.** The accent appears on at most ~10% of any screen: primary action, active nav, selection, focus, the chart, and the awaiting-review state. If cobalt is decorating something, it's wrong.
**The Signal Rule.** State colours mean states, and live on the **state/signal layer** — a column lane, a dot, a count pill, a state pill — never smeared across content and never decorative. A colour the operator can't parse as a state is noise. (*API-docs carve-out, retained from the Ledger:* on the developer-facing API reference only, HTTP-method and response-code pills reuse these tints as a redundant second cue to the always-shown verb/code text.) (*Mirrored-card carve-out (2026-08-08, issue #34):* a mirrored Task's `escalated` tag reuses Running amber's tint/ink. An afk→hitl escalation is the operator's cue that autonomous work now needs them — the closest existing meaning to "work in flight, now yours" — so it earns the amber even though the Task lands back in *ready*, not *running*. The one sanctioned non-state use of a state colour, confined to the mirrored card.)
**The Cool-Neutral Rule.** Neutrals carry no hue in either theme; warmth or coolness comes only from the accent and the state family.

## 3. Typography

**Display / UI / Body:** system sans (ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto). Character comes from a deliberate scale, weight, and spacing — not an exotic face. (Space Grotesk is retired with the Ledger.)
**Code:** JetBrains Mono (ui-monospace fallback) — **code only.**

Three working weights: 400 body / 500 UI emphasis / 600–700 headings. `tabular-nums` is inherent everywhere digits appear, so numbers line up in sans without needing mono.

### Hierarchy (fixed rem scale)
- **Display** (700, 1.25rem/1.2, −0.015em): view/page titles.
- **Hero** (750, ~3.25rem, −0.03em): the single big figure on Stats (cost). Rare.
- **Title** (600, 0.9375rem): card and section headings.
- **Body** (400, 0.90625rem/1.5): prose, agent messages, UI copy. Prose caps at ~72ch; tables and streams may run full width.
- **Small** (0.75rem): metadata lines, notes, telemetry.
- **Label** (600, 0.6875rem, +0.05em, uppercase): field labels and table headers. The only uppercase in the system.
- **Code** (mono, 0.8125rem): file paths, shell commands, branch refs, tool targets, inline code tokens.

### Named rules
**The Mono Is Code Rule (tightened).** Monospace appears *only* where the operator reads genuine code: file paths, shell commands, branch refs, tool-call targets, and inline code tokens. **Everything the operator reads as language or as a figure is sans** — model names, harness names, costs, token counts, ordinary ids, timestamps, statuses, and telemetry all set in sans with `tabular-nums`. Setting a whole metadata line in mono was the Ledger's core regression; a mono model-name or a mono telemetry strip is a regression here. (This supersedes the Ledger's "Mono Is Data Rule," which read too broadly.)
**The Three Weights Rule.** 400 / 500 / 600 (700 for display titles). If hierarchy needs more, fix the size or the colour layer.

## 4. Elevation

Depth is real but quiet, and theme-aware (the Soft Depth Rule):
- **Light:** cards float on the canvas with a soft two-layer shadow (`0 1px 2px rgb(20 22 45 / .05), 0 8px 24px rgb(20 22 45 / .06)`); floating elements (save bar, dialogs, the conversation dock, toasts) use the float shadow (`0 12px 32px rgb(20 22 45 / .12)`).
- **Dark:** shadows fade on a dark field, so depth comes from lightness steps (#0E1016 canvas → #14161D shell → #171A22 surface → #1F232D raised); floating elements keep a hairline ring so they still separate.
- Hairlines mark shared edges only (the sidebar's edge, a section divider, a column-header underline). They are **never** used as ruled list rows — grouping is whitespace + elevation (this was the Ledger's #1 systemic regression).
- The focus ring is a 2px cobalt outline, offset 2px, everywhere.

## 5. Layout & Information Architecture

**App shell.** A slim left **sidebar** (~196px on Shell, hairline right edge): the wordmark, the Workspace switcher, primary nav (Board / Activity / Table / Stats / API / Workspace) as minimal line-icon + label rows (active = accent text on Accent Tint), and a collapse toggle pinned bottom. Below ~900px it collapses to a top row of icons. A thin **status strip** across the top of the working area carries *status, not navigation* — the auto-runner switch, running count (amber dot), today's cost — then, right-aligned, the global **Settings** icon (its entry lives here, not in the rail — ADR 0012), theme-cycle, Log out, and the view's one primary action — kept low-key. The **working view** fills the rest. The **Conversation** is a docked panel on the right, floating over the board.

**The shell is pinned; only the working view scrolls** (2026-07-17). The sidebar and status strip hold their place at every scroll position, and the region below the strip is the app's one scroll container. This is a structural commitment, not a preference: the strip's bottom edge is not a constant to hardcode — it measures 63px on the rail, 121px below 900px (the sidebar becomes a top drawer and pushes it down), and 165px under ~520px (the strip wraps to two rows). Pinning the shell turns that moving edge into a *layout* boundary, so anything that hangs below the strip — the Conversation dock, the toast stack — insets off the region instead of guessing a number. Reaching for a `top-[Nrem]` on a floating element means this boundary was bypassed.

**Content-first ranking (per surface):**
- **Board** — the task *titles* are the content; everything else recedes to one faint line.
- **Task detail** — the *event stream* (the agent's work) is the content and gets the room; run-meta is one quiet line; the review gate is the one loud element.
- **Conversation** — the *transcript* is the content; telemetry is one whispered line.
- **Stats** — here the metrics *are* the content, so the hero figure + chart lead; chrome is stripped around them.
- **Settings** — the controls are the content; sections grouped by air.

**Structure by air.** Whitespace and elevation group things. Hairlines are for shared edges and the occasional section/column divider — never ruled list rows. Spacing rides a 4 / 8 / 12 / 16 / 24 / 32 rhythm; cards get generous (16–24px) padding.

## 6. Components

### Buttons
- **Primary:** cobalt fill, white/near-black text, 9px radius, weight 600. One per view (plus the review gate's Accept).
- **Ghost:** surface fill with 1px Edge border, ink text; hover darkens the border.
- **Quiet:** muted text link, weight 500, hover to ink; destructive quiet hovers to Failed rose.
- **Review gate:** the gate is **two verbs, Accept and Reject** — a reviewed Task merges or fails, and nothing else belongs in the row. Accept is the cobalt primary and sits **last**, so the affirmative holds the terminal position; Reject is the **Ghost** (amended 2026-07-16: this line read "a quiet ghost" while § Task detail read "Reject… (quiet)", naming both roles at once — Ghost wins, because the Quiet role is what a *third* action would take, and there is no third action). Accept is deliberately unguarded (PRODUCT.md: "the review gate is sacred" — the operator's read *is* the review; a worktree conflict returns the Task to *awaiting-review*). Reject opens a dialog because it takes a reason, not because it needs a guard.
- **Cancel is not a gate action** (2026-07-16). Once work exists, *cancelled* and *failed* are two names for one terminal fact, and offering both asks the operator to choose between synonyms — while rendering as a second quiet destructive action beside Reject, identical in treatment and different in meaning. Cancel keeps its meaning only where a Task has produced nothing to judge (Draft / Blocked / Ready) or is still producing it (Running). The domain stays permissive: the API can still cancel an awaiting-review Task; the interface simply doesn't offer it.
- **Hover/Focus:** 150ms ease-out; 2px cobalt `:focus-visible` outline. **Disabled:** 50% opacity.

### Chips, dots & pills (the state layer)
- **State dot:** a 6–8px dot in the state's colour — the lightest-weight state signal, used before a card title or in a list.
- **Count pill:** a column's count in its lane colour on a ~15% tint of that colour (Raised/Faint when neutral).
- **State pill:** state text in its colour on its tint, full-pill — used in tables and the task header. Small (11px, weight 600).
- Metadata chips are avoided on cards; a card's metadata is **one truncating line**, never a slab of chips. (*Mirrored-card exception (2026-08-08, issue #34):* a **mirrored** Task card leads with a role badge row — drive (`Auto`/`You`), the neutral type tag, and the amber `escalated` tag — because the wayfinder role is the one thing the column can't say, and the D6 study (prototype A) settled on quiet chips over a smeared metadata line. Native cards keep the one-line rule unchanged.)

### The Board (signature view)
- Active pipeline **columns** (Draft, Blocked, Ready, Running, Awaiting review), fixed ~262px width, in a horizontal `overflow-x` rail so the page never scrolls sideways. Each column header carries its **lane colour** — a coloured bottom-rule + a lane dot + a tinted count pill: Draft neutral · Blocked slate · Ready green · Running amber · Awaiting cobalt. This is where the board gets its colour.
- **Task cards** are calm: the **title is the hero** (ink, 600); below it, **one faint metadata line** (`claude · sonnet-5 · #4821`) in sans. No state pill on the card — the column already says the state; at most a single state dot before the title. Running cards add one quiet line (amber pulse dot + elapsed · tool count). (**Built** (2026-08-17, issue #100): the running line rides the same task-list seam as the diffstat — `taskToApi` carries the running run's `runStartedAt` and a snapshotted `toolCount` on the row, read O(1) per card. Elapsed ticks client-side off `runStartedAt` (a once-a-second `now`, the Activity view's pattern) so reduced motion drops only the amber pulse, never the figures; the tool count ticks live too, off the same `run_usage` firehose the Activity view merges (matched to the card by the running run's id, `runId`), with the server-snapshotted `toolCount` standing in as the initial value until the first firehose event lands.) Awaiting-review cards add the branch + diffstat (`agent/… · +142 −38`) above the Accept / Reject gate, so you see the size of what you're accepting before the merge. (**Built** (2026-08-08, issue #36): the diffstat is **snapshotted, not computed live**. When a worktree Run settles to awaiting-review the runner takes one `git diff --stat` and persists it on the Run (`runs.stat`); the task-list payload carries it on the same seam as `branch` (slice #17), so a board refresh — WebSocket event or poll — reads it O(1) from the row and spawns **zero** git processes per card. The compute-on-demand alternative was rejected: run-scoped and behind git, it meant N spawns per refresh or a cache/TTL + thundering-herd of our own. What persist gives up is live freshness — but a `base...branch` three-dot stat is fixed by the branch's own commits, and the branch is frozen once awaiting-review, so the base advancing underneath doesn't move it; only an out-of-band rebase could, which is not a flow here. To keep the card and Task detail from ever disagreeing, `GET /runs/:id/diff` now serves the same snapshot (computing live only for pre-snapshot runs). Unavailable/not-yet-computed → the card renders nothing (no `+0 −0`, no invented numbers); direct-mode Tasks have no branch and show neither.)
- **Mirrored cards** (tracker-projected Tasks, issue #34) are the one card that carries a role badge row above the hero title: the drive badge (`Auto` on Tooling cyan since Harmonic is the actor — harness chrome, not a state; `You` neutral), the neutral type tag (research/prototype/grilling/implement), and — when escalated — the amber `escalated` tag (see the Signal Rule's mirrored-card carve-out). Below the title, one faint line names the parent Map + tracker ref in place of the harness·model line. The card stays brief — the clamped title only; the full ticket description reads in Task detail (§ Task detail). Native cards are unchanged.
- **Finished** work collapses to one compact Raised panel: Completed / Failed / Cancelled counts with coloured dots (fail red when > 0). Full terminal history lives in the Table view.
- Loading is a skeleton board (pulsing Raised blocks), never a spinner.

### Task detail
- Title + a small state pill + the id (faint), and nothing else — the dismiss is the dialog's own X (§ Dialogs), never a hand-rolled one. (Amended 2026-07-17: this line used to place "Quiet actions (Rerun / Cancel) to the right" of the title. It described an early mock, not the product: there is no *Rerun* — the Task actions are accept / reject / reattempt / run / ready / edit / cancel — and splitting some of them into a header row would fork the one action vocabulary the board card and this panel share. **Every Task action lives in the footer**, below.)
- **Run-meta is one quiet sans line**, not a boxed band: `completed · end_turn · started 4m ago · 48.2K · $0.52 · agent/4810-dark-mode · +142 −38` (only the branch is mono).
- **Mirrored Tasks render their description as Markdown** on the Description tab (issue #34) — the full tracker-issue body, sanitized, styled under `.markdown` (mono only on code). This is where a ticket's structure reads; the board card stays a clamped title. Native Task prompts stay plain (operator-typed, not Markdown).
- Minimal underline **tabs** (Description / Output / Changes / Details). The **description lives on its own tab**, not the header (issue #34 follow-up): a header-mounted prompt — especially a rendered Markdown body — starved the Output tab of height. The header keeps only the one-line meta (id · state · harness·model · cost).
- **The event stream is the content:** agent prose in Body sans (readable, ~72ch, comfortable line-height); tool calls as a calm quiet list — a small cyan KIND tag + target (mono path/command, truncated) + a ✓/pulse; thoughts in muted italic. One row per tool (folded from `tool_call` + `tool_call_update` — see `web/src/event-stream-model.ts`). The stream is never boxed row-by-row.
- **The footer carries the Task's actions**, whatever they are in its state, from the one map the board card also reads (`web/src/task-actions-model.ts`), so the two surfaces can never drift. Terminal states offer none and the footer disappears. On *awaiting-review* that footer **is** the review gate, and it is the loudest thing on the panel: Reject… (Ghost) then Accept & merge (cobalt, last), with a tiny faint note. Elsewhere it is quiet: Run now / Ready / Re-attempt take the Ghost (the state's forward move), Edit stays Quiet below them, and Cancel is quiet-destructive. On the board card the same secondary actions drop to Quiet text — the card is a glance, not a console.

### Conversation (docked panel)
- **It runs the full height of the working view**, right-hand side, 1rem off the region's top, bottom and right edges (2026-07-17). It used to be a 32rem box floating 6rem off the bottom, which opened it half-way up the page and wasted the top half of the transcript on empty space. The transcript is the content (below) and height is what it wants. The panel takes its top edge from the pinned shell's below-strip region (§ 5), never from a hardcoded inset.
- Header: title + tiny rename affordance + id + a small "Active" dot; expand/close icons faint; End/Delete as tiny quiet links; a second faint line for `harness · model · path`.
- **Telemetry is ONE quiet inline line** — `273.7K tokens · $0.38 · 41% context` in Small muted sans. It is a status glance, **never** a grid of feature-sized cells. (This was the specific Ledger failure.)
- **The transcript is the content:** the operator's message as a small right-aligned Accent-Tint bubble; agent prose in sans; folded tool lines quiet; a **permission prompt** as the one prominent element (soft amber-tint band — the harness is blocked — with Allow once / Allow always / Reject).
- Composer: a calm textarea + Send.

### Stats
- **Hero cost** figure (Hero role, ink) leads — no card-in-a-card — with a quiet stat row (runs · tokens · cache). The **cost-per-day chart** is a single cobalt series (2px line, soft area fill, faint grid, emphasised labelled endpoint, honest `≥` floor for partial days). A calm table below (state pills, sans figures with tabular-nums, hairline row dividers used sparingly).

### Settings
- Section cards (Defaults / Harnesses / Notifications), grouped by air, ~22px padding. Harnesses use disclosure rows. A **floating save bar** pins on dirty state (Discard / Save changes; Save is the view's one primary).

### Dialogs & Toasts
- Native `<dialog>`, Surface fill, 12–14px radius, float shadow (hairline ring in dark), backdrop `rgb(0 0 0 / 0.5)`, 150ms fade/scale with a reduced-motion instant alternative.
- **The dismiss is one X, top-right, owned by `Modal`** (2026-07-16) — Faint per § 2 (an icon-only affordance), hover to Ink. Escape and backdrop-click are invisible, so a dialog needs exactly one *visible* way out, and it is the same one everywhere. **A dialog footer carries only outcomes**: no "Close", no "Cancel"-meaning-dismiss (that word belongs to abandoning a Task), and no second hand-rolled ✕.
- A dialog or floating panel titles itself in the **Display** role — it is its own view (`panelTitle` in `web/src/ui.ts`). There is no role between Title and Display; the Ledger's "Headline" is retired (2026-07-16), and reaching for a size in that gap means the surface is either a section (Title) or a view (Display), not a third thing.
- A rejected operation never uses a native `alert()`/`confirm()` — it announces in a top-right stack of Failed-tint toast cards hanging off the header's bottom edge (`aria-live`, Dismiss, ~6s auto-dismiss, `motion-safe` descend). See `web/src/toast.tsx`. (Moved from bottom-right 2026-07-16: the closed Conversation launcher now sits flush on the bottom edge as a drawer tab, so the bottom-right corner belongs to it alone — the toast stack no longer has to dodge the launcher, nor the launcher the stack.)
- **The stack dodges an open Conversation dock** — left by the dock's width, so the two never share the top-right corner (2026-07-17). The line above hoped dodging was retired for good; making the dock full-height (§ Conversation) took that back, because a top-anchored dock and a top-right toast want the same corner. What is retired is the *mutual* dodge: this is one-way (the stack reads the dock's `data-dock` via `group-has-`; the dock knows nothing of toasts). An error is often raised **by** the dock — a failed send, a failed permission answer — so landing on its title row and its primary action is the one place a toast must not be. Below 1080px, and when the dock is *expanded*, there is nowhere to dodge to and the toast simply wins on z-index for its ~6s.

## 7. Do's and Don'ts

### Do
- **Do** lead with content — make the tasks / the run / the message the loudest thing, and whisper metadata, telemetry, ids, and status.
- **Do** hold the One Cobalt Rule: accent only for primary action, active nav, selection, focus, chart, and the awaiting-review state — ≤10% of any screen.
- **Do** put colour on the state/signal layer (lanes, dots, count/state pills) where it means something; keep card and detail *bodies* calm.
- **Do** set everything the operator reads as language or as a figure in sans with `tabular-nums`; reserve mono for genuine code (the Mono Is Code Rule).
- **Do** carry structure with whitespace + elevation; floor informational text at Muted (4.5:1) — Faint is for icon-only affordances, disabled, and decorative dots, never a text label that must be read; design every change in both themes; give every control default/hover/focus-visible/disabled states and every animation a `prefers-reduced-motion` alternative.
- **Do** give every interactive control a ≥44×44px touch target (issue #56) — expand the *hit area*, not necessarily the visual: a compact glyph can carry an overflowing transparent overlay so density survives. The floor is carried by the shared vocabulary, not re-derived per surface (issue #89): the pill buttons (`btnPrimary`/`btnGhost` and kin) and the one `selectField` bake in `min-h-11`; icon-only glyphs compose `touchTarget`/`touchTargetInline` to grow their box, or drop in a `touchOverlay` span where the surface's density must be preserved (a table sort header, a tab pill, the Modal ✕). Under reduced motion, drop the animation but keep the live data updating (numbers tick from JS, never a CSS animation). A tabular readout (e.g. Activity) carries real table semantics — `role="table"`/`rowgroup`/`row`/`columnheader`/`cell` — with an sr-only label on each metric value so a screen reader reads it as a column.

### Don't
- **Don't** let chrome out-shout content — no feature-sized telemetry grids, no stacked metadata chips (except the mirrored card's role badge row, § 6 Chips), no boxed-per-row streams.
- **Don't** carry structure with ruled hairline rows (`divide-y`/`border-t` stacks) — that was the Ledger's core regression; group with air.
- **Don't** set prose, labels, model/harness names, costs, ordinary ids, or telemetry in monospace (Mono Is Code Rule). A mono metadata line is a regression.
- **Don't** use state colours decoratively or smear them across content; don't pair a border with a wide shadow (ghost-card), tint the neutrals toward any hue, use gradient text, glassmorphism, or side-stripe borders; don't nest cards inside cards.
- **Don't** fall back to a native `alert()`/`confirm()` — failures surface in the designed toast.
- **Don't** let cobalt mean anything but the interface's voice — tooling metadata is cyan, there is no generic info blue, and no second accent exists.
- **Don't** reintroduce the Ledger (ruled rows, mono-everything) or the Signal Console (scanlines, glow, rotated rails) — both are retired.
