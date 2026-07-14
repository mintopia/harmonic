# Board column treatment: prototype dense grid vs collapsed rails

Status: done (2026-07-14)

## Parent

Design system init (2026-07-14) — `DESIGN.md` § Components > The Board (marked "variant exploration pending")

## What to build

A throwaway prototype (or `$impeccable live` session against the dev
server) that renders the Board's 8 lifecycle columns both ways, side by
side with realistic Task volumes, so the operator can pick one and the
spec stops being non-normative:

1. **Dense grid** — tighter min column width (~180px), 8px gaps, compact
   cards; aim: all 8 columns visible on one monitor without horizontal
   scroll.
2. **Collapsed rails** — empty (or terminal-state) columns collapse to
   slim vertical bars with a rotated Label + count, expanding on click;
   occupied columns absorb the reclaimed width.

Evaluate against PRODUCT.md's "glanceable state first" principle and the
Two-Second Board Rule: which variant reads faster from a side monitor at
realistic mixes (empty deck, busy deck, mostly-terminal deck)?

Prototype code is disposable and does not merge. The deliverable is the
decision.

## Acceptance criteria

- [x] Both variants viewable with seeded realistic data (empty / busy / terminal-heavy mixes)
- [x] Operator picks a winner (or a hybrid, e.g. collapse only Cancelled/Failed)
- [x] DESIGN.md § The Board updated: chosen treatment becomes normative, the TARGET comment's open question removed
- [x] Follow-up noted on issue 19 (or a new issue) to implement the chosen treatment in the real Board

## Decision (2026-07-14)

**Winner: the hybrid rail treatment** (prototype variant C), picked by the
operator from a three-variant prototype (A dense grid / B empty-collapse
rails / C hybrid) at `.scratch/agentdeck-v1/prototypes/20-board-columns.html`,
published at https://claude.ai/code/artifact/06704d03-17cf-40d6-828a-82417a0fcac0
(`?variant=A|B|C`, `?mix=empty|busy|terminal`).

- The five active pipeline columns (Draft, Blocked, Ready, Running,
  Awaiting Review) are always expanded (min ~200px, 8px gaps).
- The three terminal columns (Completed, Failed, Cancelled) are always
  slim vertical rails (~36px) with rotated Label + count; a Failed rail
  with count > 0 shows its count in Fail Red; click expands in place.
- Rationale: load-independent geometry — glance targets never move.
  A (dense grid) spent 3/8 of the board on finished work and wrapped the
  Accept/Reject actions at 180px; B (empty-collapse) reflowed the layout
  during exactly the busy stretches when glancing matters, and collapsed
  nothing on a busy deck.

**Typography amendment (same session):** operator feedback on the
prototype — "way too much monospace… much preferred the previous
sans-serif styling" — reversed DESIGN.md's mono-everything doctrine.
The One Family Rule is replaced by the **Mono Is Data Rule**: system
sans for all UI chrome and prose; JetBrains Mono only for data (ids,
costs, harness · model, branches, timestamps, streams — counts stay in
their surrounding role with tabular-nums). DESIGN.md § 3 and
`.impeccable/design.json` amended; issue 19 updated to match.

## Blocked by

Nothing. Can run before or in parallel with `19-terminal-native-app-shell.md`; its outcome feeds the board's final layout there.
