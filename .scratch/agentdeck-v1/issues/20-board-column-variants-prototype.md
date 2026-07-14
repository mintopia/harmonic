# Board column treatment: prototype dense grid vs collapsed rails

Status: ready

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

- [ ] Both variants viewable with seeded realistic data (empty / busy / terminal-heavy mixes)
- [ ] Operator picks a winner (or a hybrid, e.g. collapse only Cancelled/Failed)
- [ ] DESIGN.md § The Board updated: chosen treatment becomes normative, the TARGET comment's open question removed
- [ ] Follow-up noted on issue 19 (or a new issue) to implement the chosen treatment in the real Board

## Blocked by

Nothing. Can run before or in parallel with `19-terminal-native-app-shell.md`; its outcome feeds the board's final layout there.
