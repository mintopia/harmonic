# Decision: Migrate the live web app to the Paper world via a token-first tracer-bullet sequence

Status: accepted
Date: 2026-08-21

## Context

DESIGN.md now documents the **Paper** operator world (superseding "Deck"), but
`web/src/index.css` and the React app still implement Deck (cobalt `#2563EB`,
panelled row-lists, a tabbed Ticket page). The design intent and the running app
have deliberately diverged; this ADR records *how* the live app is brought onto
Paper.

Migration-relevant facts about today's `web/` (inventory 2026-08-21):
- Vite + **Tailwind v4**. A single `web/src/index.css` (~446 lines) defines
  `--hm-*` custom properties **three times** — `:root` (light),
  `:root[data-theme='dark']`, and `@media(prefers-color-scheme:dark) :root:not([data-theme='light'])`
  — and an `@theme inline` block maps them to Tailwind utilities. Every token
  edit is mechanical but triplicated.
- `tests/contrast.test.ts` parses those tokens and fails the build if any
  documented pairing drops below its floor. It is the CI gate.
- Home is `components/Deck.tsx` (~705 lines) + `deck-model.ts`/`board-model.ts`,
  rendered as **panelled row-lists** — not Paper's horizontal card strips.
- A dependency DAG already exists (`GraphView.tsx`/`graph-model.ts`/
  `graph-layout.ts`, elk-based) and is reusable for the epic **frontier-DAG**;
  there is no `epic-frontier-model` yet. Epics today render as a "Landing"
  merge-train (`EpicBand`).
- `components/TicketPage.tsx` (~981 lines) is still a **tabbed** shape; run-rail
  scaffolding (`components/ticket/RunRail.tsx`, `Gate.tsx`, and `run-rail-model`/
  `ticket-gate-model`/`rail-model` tests) exists but is not wired as the page body.
- `Modal.tsx` is already a native `<dialog>` with `::backdrop`. `id-format.ts`
  (the `T-<id>` / `#<ref>` formatter) stays. "landing/landed" in UI copy is
  narrow: the `landing` phase label and Deck's `Landing`/`landed`/`folded`.

Alternatives considered: (a) a big-bang rewrite of the whole UI in one branch —
rejected, it parks the app in a broken state for the length of the migration and
fights the review gate; (b) building Paper as a parallel route behind a flag —
rejected as premature, the surfaces are the app, and a flag doubles the surface
area to maintain.

## Decision

Migrate **token-first, then surface-by-surface**, as tracer-bullet vertical
slices sequenced so the app stays green (builds, renders, contrast test passes)
after every slice. Delivered as GitHub epic + eight `ready-for-agent` children:

1. **Paper token foundation + contrast gate** — revalue every `--hm-*` (×3) to
   Paper; add `await`, `on-await`, `on-done`, `sunken`, `edge-strong`; a `.bold`
   density layer + tint washes; `@theme` radii 8/10/13. Update `contrast.test.ts`
   to the Paper pairings and the flipped-ink pairs, with an explicit **ADR-0033**
   carve-out for the running amber. Re-skins the existing Deck components to
   Paper colour — no structural change, app green.
2. **Two-voice + merged vocabulary** — indigo `await` becomes the
   awaiting-review / needs-you hue (retiring Deck's "awaiting-review = the
   accent"); `accept`→`merged`; `landing`→`merging` and Deck's
   `Landing`/`landed`/`folded`→`merging`/`merged`.
3. **Shell** — `App.tsx` landmarks (`nav`/`main`/`header`/`aside`); Soft↔Bold
   toggle (persisted) + theme cycle; rail labelled "Board"; indigo needs-you badge.
4. **Board home as card strips** — replace the panelled row-lists with Needs-you /
   Active horizontal card strips + first-class Standalone cards; a Card with the
   colored left accent bar, HITL/epic badges, branch ref, ctx%, and the
   "→ N more" overflow affordance.
5. **Epic frontier-DAG** — a new `epic-frontier-model.ts` (Frontier + Depth
   buckets, merged members hidden, satisfied-dependency chips) rendered as
   collapsible bands → a column DAG with no connector lines and merge-train pips
   (one green).
6. **Ticket run rail + Run-OR-Changes** — rework `TicketPage` from tabs to the
   sidebar-driven Run-OR-Changes shape, wiring the existing `RunRail`/`Gate`
   scaffolding; per-agent usage table; flat metrics row; epic crumb; a sticky
   review gate (Accept & merge / Reject…).
7. **Cross-cutting a11y + motion pass** — `aria-live` regions (polite state +
   needs-you count, assertive merge outcome), 44px hit targets, decorative
   `aria-hidden`, reduced-motion across the new surfaces; re-run the audit.
8. **Retire Deck + refresh design artifacts** — delete Deck-only dead code, drop
   the `deck.html` reference, refresh the stale `.impeccable/design.json` snapshot.

Dependency graph: c1 is the root; c2 and c3 depend only on c1 (parallel); c4
needs c1+c2; c5 needs c1+c4; c6 needs c1+c2; c7 needs c4+c5+c6; c8 needs
c4+c5+c6+c7.

## Consequences

- The contrast test stays the hard gate; c1 must land the token revalue and the
  test update together so CI never goes red. The running-amber carve-out is the
  one sanctioned sub-AA pairing (ADR-0033).
- The app is visually Paper from c1 onward even though the surfaces reshape over
  c4–c6 — an intentional "coloured but not yet re-shaped" interim, not a bug.
- Triplicated token blocks mean c1 is mechanical but wide; the contrast test
  guards correctness.
- The existing elk DAG (`graph-layout.ts`) is reused for the frontier-DAG rather
  than a new layout engine; the frontier-DAG draws no connector lines, so only
  the depth-bucketing is new (`epic-frontier-model.ts`).
- `web/src/index.css`'s three-place theme definition is retained (light /
  `data-theme` / system) — this migration does not change the theming mechanism,
  only the values, plus the new Soft/Bold density layer.
- Which of Light/Dark and Soft/Bold ships as the *default* is out of scope here
  and decided separately.

## Supersedes

None. Implements the Paper world recorded in DESIGN.md; the running-amber
exception is ADR-0033.
