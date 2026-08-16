---
target: the whole Harmonic web app
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 5
p1_count: 6
timestamp: 2026-08-16T15-59-15Z
slug: harmonic-web-app-holistic
---
# Harmonic — Holistic Design Critique (whole application)

**Method:** dual-track, multi-agent. Three isolated design-director reviews (shell+queue / deep-dive+streaming / config+read) read the source unanchored; one evidence agent relaunched the live app, captured 111 screenshots (every surface × desktop 1440 + mobile 390 × light + dark), and ran the browser overlay detector. Every contrast figure below was computed independently by ≥2 agents from the tokens in `web/src/index.css` **and** measured live in-browser — they agree.

**Live app (seeded, ungated):** https://harmonic-critique.tumbling-zelenka.ws.cloudagent.mintopia.net · **Screenshots:** `/home/workspace/.critique-shots/` · **Stop the server:** `pkill -f "cli.ts serve"`

---

## The one-paragraph verdict

Harmonic is a **genuinely high-craft codebase wearing a design system most products never earn** — `ui.ts` and the model files carry *arguments*, not just values, and several surfaces (Activity, the event stream, Stats, the Modal primitive, onboarding) are authored with real point of view. But the same three failures repeat on almost every surface, and they are exactly the failures the brand's own principles forbid: **the light theme misses its own AA contrast floor system-wide**, **the ≥44px touch-target floor is defined and then used on only two surfaces**, and **the product's live content is invisible to assistive tech**. Underneath those sit a handful of hard functional bugs and a slow structural drift in the vocabulary the system's whole value depends on. The ceiling is very high; the current build sits well below it.

**App-wide health: ~22/40 — Acceptable, lower band. High ceiling, systemic floor problems.**

---

## Per-surface scorecard

| Surface | Band | The headline |
|---|---|---|
| App shell | ~22/40 | Pinned-scroll model is beautifully built; but active-nav 4.44:1, no 44px targets, no routing, no `<h1>`/skip-link |
| Board | 21/40 | Title isn't the hero (400 wt); every state pill sub-AA; running lane is inert; Awaiting-review scrolls off-screen |
| Table | ~18/40 | Weakest-authored; a failed fetch bricks it permanently (no `.catch`); sub-AA on refetch; mouse-only rows |
| Activity | ~28/40 | **Best surface.** The a11y reference implementation — honest context gauge, 44px hit-area trick, JS-tick under reduced-motion. Minor grid/tree ARIA gaps |
| Task detail + gate | ~21/40 | Gate is the *fifth* cobalt element, not the loudest; **tabs are keyboard-unreachable** (P0) |
| Event stream | ~26/40 | Highest design-specificity (tool-call fold, noise deletion) — and **silent to screen readers** |
| Conversation dock | ~23/40 | Honest telemetry line is exemplary; permission prompt reads as an FYI (grey, not amber, no live region); Delete unguarded |
| Stats | ~24/40 | Most confident surface; but the cost chart **totals unpriceable days as $0** and calls it exact (Honest-Numbers breach) |
| API reference | ~22/40 | Payload panel (subgrid alignment) is excellent; broken tab ARIA; no search / no deep-link on a READ surface |
| Settings | ~19/40 | **You cannot type an env-var or model name** (key-by-value remount); Discard doesn't revert "immediate" sections; off-switch invisible |
| Workspace | ~23/40 | Right to be derivative; but the delete confirm is weaker than its own docstring, and its footer inverts weight |
| Graph | ~24/40 | Highest specificity; keyboard-hostile (focus doesn't pan); edge colour is the only carrier of meaning, no legend |
| Dialogs / empty | ~27/40 | Modal is the strongest shared primitive in the app; its close X is the smallest, faintest control (2.91:1, ~20px) |

---

## The 7 systemic themes (this is the real finding)

### 1. The light theme fails its own AA floor — system-wide, one root cause
Computed three ways, measured live once. In **light** mode:

| Pair | Ratio | | Pair | Ratio |
|---|---|---|---|---|
| running / running-tint | **4.10** | | tool / tool-tint | **3.52** |
| ready / ready-tint | **4.31** | | tool on surface (Grant, Stats col) | **4.07** |
| blocked / blocked-tint | **4.28** | | accent / accent-tint (active nav, awaiting) | **4.44** |
| fail / fail-tint | **4.06** | | **faint on surface** (branch, X, meta) | **2.91** |
| accept / accept-tint | 4.61 ✓ (only pass) | | **faint on canvas** (Graph map/id) | **2.82** |
| | | | white knob on edge (Switch off) | **1.33** |

Every tinted state chip, the active-nav treatment DESIGN names as *the* example, the awaiting-review state, the permission Grant button, the Switch's off state — all below floor **in the default-for-a-side-monitor light theme**. Dark clears the floor everywhere. "Dual theme, both first-class" is currently one-and-a-half. Compounding it: **whole-element `opacity` used as a de-emphasis device** (`ProcessTree` idle rows `opacity-55` → 2.41:1; `TableView` refetch `opacity-60` → 2.65:1) drops real text further still. This is one token pass in `:root`, plus retiring `opacity-*` for a weight/colour step — the fix Activity's `StopButton` already models.

### 2. The ≥44px touch-target floor is defined and then ignored on all but two surfaces
`ui.ts:20–21` ships `touchTarget`/`touchTargetInline` *for exactly this*, and **Activity + Graph are the only importers.** Everywhere else: shell rail items ~38px, the header icon trio 36×36, the review-gate buttons ~38px, the dock header's six 16×16 icon buttons, the Modal close ~20×16, Table's sort headers ~13px, Settings' `✕`/Show/Hide ~30px, API's tab pills ~19px. DESIGN §7 states the floor "non-negotiable." Fold `min-h-11` into `btnPrimary`/`btnGhost` and wrap the icon buttons — a stated floor with a ready-made tool and a working in-repo reference.

### 3. The product's live content is invisible to assistive tech
There is **no `aria-live` on the event stream, the transcript, or the permission prompt** — the three things this product *is*. An agent can run ten minutes emitting prose and forty tool calls and the page announces nothing. Worse: on Task detail the review **tabs use a roving `tabIndex` with no arrow-key handler**, so a keyboard operator can reach the gate but literally **cannot open Output/Changes/Details to read the work they're being asked to accept** (P0). Add to that: no `<h1>` in the authed app, no skip link past 8 shell controls, error banners and Login errors with no `role="alert"`, the process tree's hierarchy carried 100% visually, and success (a merge!) announced by nothing. Activity proves this team *can* do a11y well — which is what makes the gaps elsewhere fixable rather than cultural.

### 4. The vocabulary is exceptional — and it's starting to fork
`ui.ts` is the best thing in the codebase: 20+ class strings each with committed reasoning. But the applications are drifting, and in a few places the *comment asserting consistency has outlived the consistency*:
- `escalated` is **amber on the Board, cobalt in Activity** — DESIGN says amber. (Breaks Signal Rule + One Cobalt, and it's the one accent that repeats per-row without bound.)
- `select` is defined twice and diverged (Table ~32px vs Activity `min-h-11`) — Activity's comment still claims they match.
- The running dot is `bg-running` in the status strip, `bg-running-dot` everywhere else — two ambers.
- Empty states use `<EmptyState>` in three places and a hand-rolled `<td colSpan>` in Table.
- "Machine Ceiling" (Settings) vs "Max concurrent runs" (Workspace) — one number, two names.
Hoist the shared pieces (`escalatedChip`, `selectField`) into `ui.ts` before the fork sets.

### 5. "Content Leads" inverts under pressure and at the decision moment
The Prime Directive holds when nothing is competing and breaks when it matters: the **Board title ships at weight 400** (quietest text on its own card); the **review gate is a normal footer**, the fifth cobalt element in its own modal; **`RunMeta` is a 7-row grid** and **`PromptTab` renders a natural-language prompt in JetBrains Mono** (both the exact thing the rules ban); Activity's grid **squeezes the process title to zero** before the telemetry columns yield; the mirrored card stacks three uppercase chips *above* the title. Content leads in the calm; chrome wins under load.

### 6. Guard rails are inverted, and success is silent
The reversible actions are guarded and the irreversible ones aren't: **Cancel is two-step armed; Accept-merge is one unguarded click** — and **dragging a running card to Cancelled SIGKILLs the agent with no confirm at all**. Conversation **Delete is unguarded twice** (one instance invisible until hover); the **Workspace delete confirm is weaker than its own docstring** (the promised type-the-name input doesn't exist). Meanwhile **no successful action is ever confirmed** — a merge just makes the card vanish into a grey count. The product whose entire promise is "nothing merges without your review" applies more friction to abandoning work than to merging it.

### 7. No routing, nothing persists
`view` is `useState` — no URL, no history, no deep link, no restore-on-refresh. The side-monitor use case ("put it on the second screen and leave it") isn't supported; the back button exits the app; and per-view filter/sort/peek state resets on every switch. This is upstream of a dozen smaller findings and gets structurally more expensive every sprint.

---

## Hard functional bugs found (beyond design)

- **Settings: env-var and model-price names can't be typed.** `HarnessSettings.tsx:64/273` key rows by the editable value → every keystroke remounts the row → focus loss. Create-then-name is impossible. *The single worst defect in the app.*
- **Table bricks on a failed fetch.** `TableView.tsx:39–45` has no `.catch` and never checks `r.ok`; one failure pins `loading=true` forever, dimming the table sub-AA permanently.
- **Cost chart is dishonest.** `CostChart.tsx:62/97/103` plots and totals `null` (unpriceable) days as `$0` and states the understated total as exact in the aria-label.
- **Inherit note misattributes its source.** `InheritField.tsx:68` hardcodes "Inherited from global default" even when the value came from a Workspace override.
- **Graph grab cursor never changes** (`GraphView.tsx:222` reads a ref during render).

---

## What's genuinely excellent (keep, and propagate)

- **The pinned-shell / single-scroll-container model** — built correctly, with the measured breakpoint heights written into a comment so floating elements inset off a *layout* boundary instead of a hardcoded number.
- **Activity is the accessibility reference implementation** — the `size-11` transparent hit-area over a 16px glyph, the JS-driven 1s tick that keeps live numbers moving under `prefers-reduced-motion`, sr-only column prefixes, the honest three-tone context-fill gauge.
- **The event stream** — one row per tool call with status advancing in place, and a docstring enumerating the noise it refuses to render. The Prime Directive actually executed.
- **Honest-numbers discipline where applied** — conversation telemetry's three-way degradation (unknown → count → %), the diffstat rendering `null` not `+0 −0`, `fillSeries`' DST-safe zero-fill that refuses to fill spans it can't label.
- **The Modal primitive + the dialog family** — the most consistent component family in the app; leans on the platform, owns one X centrally.
- **`onboarding-model.ts`** — the best-reasoned file in the repo; encodes that the cold-start cliff is "a *ready* task with the auto-runner off," not "no tasks."
- **The materials** — hand-drawn 16px icon set with per-glyph rationale, the static four-bar BrandMark, `ModelCombobox`'s real keyboard contract, `ApiReference`'s subgrid alignment, `task-actions-model.ts` hoisting the gate's action-vocabulary so two surfaces can't disagree.

---

## App-wide priority list

**P0 — fix first (correctness + floor)**
1. **Contrast token pass** (`index.css :root`): darken the state-text tokens ~8–10% and lift `--hm-faint` to ≥4.5:1; give the Switch off-state a knob ring + darker track. Add a token-pair contrast assertion to the test suite so a tint edit can't regress it. Dark needs no change. *~1 hr, fixes theme 1 everywhere.*
2. **Settings can't type names** — key `HarnessSettings` rows by index/stable id, commit rename on blur. *~30 min.*
3. **Keyboard operators can't read the work they accept** — add arrow-key handling to the Task-detail tablist + `tabIndex={0}` on the scroll body. *~30 min.*
4. **Cost chart honesty** — break the line across `null` days, prefix the total/aria with "at least" when any day is unpriced. *~1 hr.*
5. **Table fetch brick** — add `.catch`/`r.ok`, replace `opacity-60` dimming with `aria-busy` + a progress hairline. *~30 min.*

**P1 — the design world is being contradicted**
6. **The 44px floor** — fold `min-h-11` into the button vocabulary + wrap icon buttons (shell, gate, dock, Modal X, Table, Settings, API). *~2–3 hrs.*
7. **aria-live on live content** — a polite region fed transitions-only off `coalesceEvents`; assertive on the permission prompt + move focus to it on mount. *~half day.*
8. **Make the gate the loudest thing** — give the awaiting-review footer its own ground + label, drop the extra cobalt (SteerBox Send → ghost, selected-run pill → neutral). Same move on the Board card (title → 600, re-quiet meta). *~2–3 hrs.*
9. **Permission prompt = amber band, not grey** — `bg-running-tint` ground, keep cyan buttons, bump the "waiting for you" line to `text-ink`. *~1 hr.*
10. **Kill the vocabulary drift** — `escalated` → amber everywhere via a shared `escalatedChip`; one `selectField`; one running-dot token. *~1 hr.*
11. **Guard the irreversible / confirm success** — remove `running` from `CANCEL_BY_DRAG`, guard Conversation + Workspace delete (add the promised name-entry), toast every successful gate action. *~2–3 hrs.*

**P2 — real, contained**
12. Running-lane aliveness (amber pulse + `elapsed · N tools`, data already ticking in Activity). 13. Wayfinding a11y (`<h1>` per view, skip link, `role="alert"` on banners/Login, real tree/table ARIA). 14. Stats state-distribution needs a heading + drop zeroes; add a loading state. 15. API reference search + hash deep-links. 16. Settings save-model made visible per-section (the "immediate" ones).

**P3 — worth a ticket**
17. Routing (URL for view + filter state) — un-blocks the side-monitor case and lost filter state. 18. Table scale (pagination + prompt search + `title` on truncation). 19. Raw `✕`/`text-xs` off-system tokens. 20. `DirectoryPicker` unused on the Task form. 21. De-duplicate the byte-identical dark `:root` blocks in `index.css`.

---

## Persona synthesis

- **Alex (power operator, the actual user):** no routing, no keyboard shortcuts anywhere, no filter/search on Board or Table, per-view state resets constantly, drag is the only accelerator and it's undiscoverable. Every affordance is tuned for ~12 tasks; at 60 it's scroll-and-hunt.
- **Sam (screen-reader / low-vision):** the systemic AA failures + the silent live content + the keyboard-unreachable review tabs make the core loop — read an agent's work, accept or reject — only partly usable. The bones are good (Activity's care proves it); the gaps are contrast, announcement, and two keyboard traps.
- **Morgan (2-second side-monitor glance — the stated primary context):** can't tell a fresh run from a stuck one (no elapsed anywhere), can't tell what changed since last glance (no motion, no live region), and the lane they care about scrolls off. The glance can't answer "is anything stuck?"

## Questions worth sitting with

1. DESIGN.md specifies the Board title at weight 600, a pulsing Running lane, an amber permission band, and a name-gated Workspace delete. **All four ship absent or different.** Which document is the source of truth — and what else in DESIGN.md is aspirational rather than descriptive?
2. Two themes were promised as first-class. Only dark clears the AA floor. Is light a real target, or the one you demo in?
3. The system's whole value is the shared vocabulary — and it's already forking, with comments asserting a consistency that no longer holds. What enforces it? (A token-contrast test + a lint against raw `✕`/`text-xs`/inline `bg-accent` would catch most of what drifted.)
