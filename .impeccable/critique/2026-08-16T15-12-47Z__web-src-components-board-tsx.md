---
target: the Board (web/src/components/Board.tsx)
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-16T15-12-47Z
slug: web-src-components-board-tsx
---
# Critique — Harmonic Board (`web/src/components/Board.tsx`)

Method: dual-agent (A: design review · B: detector + live-browser evidence). Both ran as isolated sub-agents; not degraded.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Only an aggregate `2/1 running` in the shell; zero per-card progress/elapsed. No `aria-live`, so WebSocket column moves are silent — cards teleport. |
| 2 | Match System / Real World | 3 | Pipeline vocabulary is right; undermined by unglossed `⇠ 2 deps`, `≥$` (silent "incomplete"), `ON FAILED`, and "Ready" as both state and verb. |
| 3 | User Control and Freedom | 2 | Uncancel/requeue/snapback are real; but no undo, and Accept merges irreversibly on one card click. |
| 4 | Consistency and Standards | 2 | Two divergent card layouts; `touchTarget` (≥44px) defined but applied nowhere here; amber reused off the state layer. |
| 5 | Error Prevention | 2 | Invalid drops correctly refused; but the guard is on Cancel (reversible), not on Accept-merge (irreversible). |
| 6 | Recognition vs Recall | 2 | Lane-colour meaning taught once on first-run, then never — no legend, no tooltip. Blocked never says what it's blocked on. |
| 7 | Flexibility and Efficiency | 1 | No keyboard shortcuts app-wide. No filter/search/sort/lane-collapse. `peeked` is component state — expansion lost on every view switch. |
| 8 | Aesthetic and Minimalist | 3 | Genuinely calm and coherent; restraint is real. Loses a point because the restraint flattened hierarchy instead of sharpening it. |
| 9 | Error Recovery | 2 | All board failures route to one generic `toastError`; no inline card error, no failure reason on the board. |
| 10 | Help and Documentation | 2 | `FirstRunBoard` is excellent, then help vanishes; both hint banners are dismiss-forever, no persistent help. |
| **Total** | | **21/40** | **Acceptable / lower band — needs work** |

Scores are honest, not graded on a curve. Assessments A and B independently converged on the two structural failures (contrast, hierarchy), which is why confidence is high.

## Design Specificity Verdict

**An authored design *system* wrapped around a category-interchangeable *board*.** The tokens are specific; the surface is not.

**LLM assessment.** Aurora is a real, disciplined system and the discipline lives in the code, not just the doc — `ui.ts` carries *arguments* (why accept-tint/fail-tint was retired, why Conversation chips can't be amber), `board-model.ts` names load-independent geometry as an operator-glance requirement. But strip the labels and the Board is a 2019 kanban: fixed 262px columns, count-pill headers, stacked white `shadow-card` cards, drag between columns. Nothing in its *structure* encodes the one thing that makes Harmonic Harmonic — a machine doing work unattended and holding it at a gate. The three product-specific moves are exactly the three missing: **time** (no elapsed on any card), **aliveness** (the Running lane has no pulse/telemetry — the only `animate-pulse` in the tree is the skeleton), and **gate emphasis** (Awaiting-review is styled identically to Draft).

**Deterministic scan.** Static `detect.mjs` on `Board.tsx` and the whole `components/` dir = **clean (0 findings)**. But the *live* in-page overlay found **9 anti-patterns** on the rendered board: 4× `low-contrast` (state count pills 4.1–4.44:1), `line-length` (~181 chars — the review banner runs full board width), `flat-type-hierarchy` (only 11/12/14.5/15px, ratio 1.4:1), `edge-flush-cards`, `clipped-overflow-container`, `layout-transition`. Two are false positives: `overused-font` (single sans is intentional Aurora) and `gradient-text` (the brand wordmark mark, not body text — verify it isn't leaking elsewhere).

**Visual evidence.** The overlay's `detect.js` did run in-page (console reported the 9 patterns); the local server has since been stopped, so there is no live overlay tab now, but full screenshots (1440px + 390px, light + dark, scrolled + all-lanes) are saved in the scratchpad. Deterministic board geometry: at 1440px the 5 pipeline lanes overflow the viewport by **342px** (scrollWidth 1534 vs client 1192); expanding a terminal column pushes overflow to **898px**. Awaiting-review — fifth in flow order — is the first lane clipped off the right edge.

## Overall Impression

The calm is real and the system-thinking is rare — this is a team that writes down *why*. What's wrong is that the discipline has been spent making the board quiet rather than making it *legible at a glance*, and two failures sit at the exact centre of the product's promise: the card title (the content) is the quietest text on its own card, and the entire signal layer misses the AA contrast floor the brand explicitly promises. Biggest opportunity: re-rank the board by **need**, not by state, and let content and the review gate actually lead.

## What's Working

1. **Load-independent geometry** (`Board.tsx:217–227`, `board-model.ts:6–16`). Every state always yields a column; terminal columns append right on peek instead of reflowing the pipeline; widths are fixed `shrink-0`. On a glance surface muscle memory is spatial — this protects it, and the reasoning is preserved in a comment. Most kanbans use `flex-1` and break this.
2. **The disclosure focus loop** (`Board.tsx:173–189`). Toggling a terminal column moves or unmounts the clicked button, so focus is deliberately handed to the control that now represents the new state. This is the exact failure mode that strands keyboard users mid-task, solved on purpose and invisible to mouse testing.
3. **Progressive disclosure of branch/diffstat** (`cardBranch.ts`). Both return `null` unless `awaiting-review`, gated at the model layer so the rule can't drift — and `null` (not `+0 −0`) when unavailable, honouring "honest numbers." Plus the first-run board is the best-authored moment in the surface.

## Priority Issues

**[P0] The card title is not the hero — hierarchy is inverted.**
`TaskCard.tsx:26–36` — `TitleButton` sets `text-ink` but **no weight, no size**, so it inherits body (400 / 14.5px). Column headers are 600, chips are 600 uppercase, Accept is a filled cobalt slab. The loudness rank on an awaiting card is: Accept > header > chips > **title**. The thing the operator came for is the quietest text on the card — a direct failure of the Prime Directive, confirmed by the live `flat-type-hierarchy` finding.
*Why it matters:* on a 2-second glance nothing pulls the eye to content, forcing a linear read; the two card species (400 vs 500) also disagree about their own hero, so mixed lanes have no scannable rhythm.
*Fix:* put `text-title font-semibold` on `TitleButton`'s base class, delete `MirroredCard`'s `font-medium` override, and re-quiet the meta line (cap at `#id`, `harness · model`, one deviation). ~30 min, highest-leverage change here.
*Suggested command:* `/impeccable typeset`

**[P0] The AA contrast floor is breached across the whole signal layer in light mode.**
Computed from tokens *and* measured live in-browser (two independent methods agree): every coloured count pill fails AA at 11px — Running 4.10:1, Blocked 4.28:1, Ready 4.31:1, Awaiting/active-nav 4.44:1, Failed 4.40:1, Tooling 3.52:1; only Completed passes (4.61:1). Worse, `text-faint` carries the awaiting-review **branch name** at **2.91:1** and zero counts at **2.60:1**, and DESIGN's own rule says faint is "never a text label that must be read." Draft/Cancelled lane rules use `border-hairline` (~1.17:1) — effectively invisible, so the "coloured rule + dot + pill" trio silently degrades to a duo on two columns. The first thing a new operator sees on `FirstRunBoard` is five sub-AA pills.
*Why it matters:* "density without gloom — AA contrast floor" is a *stated* principle; this is arithmetic, not taste, and it hits the exact layer the glance depends on.
*Fix:* darken the tint text tokens to ≈4.6:1 (A computed concrete hexes, e.g. `--hm-faint #9296b0→#666b8d`, `--hm-running #b25e06→#a65706`), move the branch off `faint`, and give Draft/Cancelled a visible neutral rule. ~45 min incl. a light-mode sweep of shared tokens.
*Suggested command:* `/impeccable audit` (verify) → `/impeccable polish` (apply)

**[P1] The review gate's guards are inverted and the merge is silent.**
Accept is unguarded (`TaskActions.tsx:72`) while Cancel is two-step armed — the reversible action is confirmed, the irreversible merge is not. The drag path is worse: `board-model.ts:65` puts `running` in `CANCEL_BY_DRAG` and `runDrop` fires immediately, so dragging a running card to Cancelled SIGKILLs a working agent with no confirm/toast/undo — while the *button* demands "Sure?" for the same outcome. And success is silent: `act()` handles only the failure path, so a merge produces no "Accepted #4821 → merged to main" — the card just vanishes into a collapsed grey `Completed` count.
*Why it matters:* "the review gate is sacred" — yet the UI applies more friction to abandoning work than to merging it, and the one-click Accept sits beside a 2.91:1 branch and an 11px diffstat.
*Fix:* remove `running` from `CANCEL_BY_DRAG` (or route it through the armed confirm); promote the diffstat to `text-ink text-small tabular-nums` (loudest metadata) so decision size shows before the verdict; toast every successful gate action.
*Suggested command:* `/impeccable harden`

**[P1] Running cards carry no evidence anything is running.**
The brief specifies an amber pulse dot + `elapsed · tool count`; grep confirms none of it ships. A running card differs from a draft card only by its column and two quiet `Complete`/`Cancel` links. The operator cannot tell a 20-second run from a 40-minute stuck one — which is the only question a side-monitor glance asks.
*Why it matters:* the Running lane is the product's heartbeat and it is inert; this is the largest gap between Harmonic's identity and its rendering.
*Fix:* the data exists — `startedAt` is on the wire and `ActivityView.tsx:419` already ticks once a second. Add an amber `motion-safe:` pulse dot before the title and one `elapsed · N tools` line in `text-small text-muted tabular-nums`. ~2–3 hrs incl. tick plumbing.
*Suggested command:* `/impeccable animate`

**[P2] No accelerators, nothing persists, and it doesn't scale past ~12 cards.**
Zero keyboard shortcuts anywhere; no filter/search/sort/lane-collapse; `peeked` is component `useState`, so expanding Completed and switching views collapses it again. Every layout decision is tuned for ~12 cards — at 60 the board is scroll-and-hunt with priority surfaced only as an 11px uppercase word. And the horizontal overflow (342→898px) means the operator can't reclaim the space that clips Awaiting-review off-screen.
*Why it matters:* the persona is a developer-operator running *many* tasks; heuristic 7 scores 1/4.
*Fix, in order:* lift `peeked` to `localStorage` (15 min); let Draft/Blocked collapse to the terminal-column rail (reclaims ~556px, un-clips Awaiting); `/` to filter, `j`/`k`/`a`/`r` for card+gate keys.
*Suggested command:* `/impeccable adapt` (overflow/lane-collapse) + `/impeccable harden` (persistence/keys)

## Persona Red Flags

**Alex (power operator, 40+ tasks):** No keyboard path anywhere — board is mouse-only end to end. `Run now`, `Edit`, `Cancel` are three identical bare text links, so the highest-frequency action is the hardest to hit. Drag is the only accelerator and it's undiscoverable (no handle, just `cursor-grab` on hover). Peek state resets on every view switch. No filter/sort/lane-collapse to reclaim the clipped column. `line-clamp-3` titles truncate with no `title`/tooltip.

**Sam (screen-reader / low vision):** Sub-AA on the decision path — branch 2.91:1, zero counts 2.60:1, all six coloured pills 3.52–4.44:1. Draft/Cancelled lane rules 1.17:1 (invisible). **No `aria-live` on the board** — WebSocket column moves are announced to no one. `BoardSkeleton` is `aria-hidden` with no `aria-busy`/status. The ≥44px target contract is defined in `ui.ts` and applied nowhere here. *Credit:* the focus loop, `aria-expanded`/`aria-label` pairs, and `motion-reduce:` gating are genuinely well done — the gaps are contrast and announcement, not structure.

**Morgan (interrupted operator, 2-sec side-monitor glance — the stated primary context):** Can't tell a fresh run from a stuck one (no elapsed). Can't tell anything changed since last glance (no motion, no `aria-live`). The column they care about (Awaiting-review) is the one that scrolls off. Nothing ranks the board by need — awaiting/failed/blocked-on-failed are scattered across three lanes plus a collapsed panel, and Morgan performs that merge mentally every glance.

## Minor Observations

- `metaLine` mixes separators in one line: `#4821  claude · sonnet-5  worktree  ≥$0.42` (double-space vs middot). Brief's example is uniformly middot.
- `MirroredCard` renders `{task.mapTitle ?? '—'}` in `text-ink` — an em-dash placeholder at full content weight.
- A state's label/colour/order live in three unlinked files (`Board.tsx:10`, `ui.ts:183–202`, `board-model.ts:40`).
- The card body is dead space — only the title opens the task; clicking the other ~80% does nothing, with no hover cue.
- Asymmetric disclosure vocabulary: expanded column uses a text `Collapse`; collapsed rows use a rotated chevron.
- Valid-drop highlight lights 2–3 columns at once — briefly exceeds the ≤10% cobalt budget (transient, deliberate).
- Both onboarding hints are dismiss-forever with nothing persistent replacing them.

## Questions to Consider

1. The board sorts by state; the operator sorts by need. Why is the operator doing that merge? A single "Needs you" lane (awaiting + failed + blocked-on-failed) answers the glance in one fixation.
2. DESIGN.md says the title is the hero at 600 and the Running lane pulses. Both ship absent. Which document is true — the doc or the board — and what else in DESIGN.md is aspirational?
3. Why does cancelling require "Sure?" while merging an agent's code into your repo does not?
4. If "the tool disappears into the task," why does a mirrored card stack three uppercase chips *above* the task?
5. Awaiting-review is fifth in the pipeline and therefore first off-screen. If the gate is sacred, should flow order beat importance order in the layout?
