# Design audit and polish pass (impeccable)

Status: done

## Parent

QA session (2026-07-14)

## What to build

An audit-then-polish pass over the whole web UI using the impeccable
skills, keeping the current visual identity: the overall structure and
aesthetic are good, but some redesign and usability changes are needed.

1. `impeccable:audit` — severity-rated report across accessibility,
   theming, responsive behaviour, and consistency — plus
   `impeccable:critique` for usability: the brief explicitly invites
   structural/usability findings, not just cosmetic ones.
2. Targeted passes driven by the audit's findings:
   `impeccable:arrange` (layout/spacing), `impeccable:typeset`
   (typography), `impeccable:polish` (final detail sweep).

Any larger redesign proposal that comes out of the audit is surfaced as
a recommendation for operator approval, not applied unilaterally.

## Acceptance criteria

- [ ] Audit report produced with severity ratings, covering usability/structural findings as well as cosmetic ones
- [ ] Arrange/typeset/polish passes applied per the report's findings
- [ ] Cost surfaces (issue 17) are included in the pass
- [ ] Current visual identity preserved; redesign-scale proposals presented for approval, not applied
- [ ] No regression in existing functionality (board, table, task detail, stats, settings)

## Blocked by

- `15-every-action-reloads-to-blank-page.md` (auditing a UI that blank-pages on every action means fighting the bug throughout)
- `17-cost-estimation.md` (UI surfaces — so the newest UI isn't the only unpolished one)

## Comments

**2026-07-14 — implemented.** Audit report (severity-rated, incl. usability critique) at `../design-audit.md`: score 14/20, 0×P0 / 3×P1 / 8×P2 / 5×P3, anti-patterns verdict clean. Applied within the existing visual identity:

- **Harden (P1):** all four modals now share a native-`<dialog>` `Modal` (focus trap, Esc, top-layer stacking, backdrop-click close, focus restore, StrictMode-safe); keyboard paths for card prompts, table rows, and sort headers (with `aria-sort`).
- **Contrast (P1):** informational text floored at `text-zinc-400` (zinc-500/600 measured 2.3–4.1:1, below WCAG AA); readable placeholders; global amber `:focus-visible` ring.
- **Clarify (P2):** `aria-label`s on icon buttons/selects/inputs, `aria-pressed` on Auto-Runner, associated labels + autocomplete in TaskForm/Login, loading-vs-empty distinction on board and table, empty-board onboarding hint.
- **Adapt/arrange (P2):** header wraps on narrow viewports, tables scroll in their own container, mobile dialog gutter, single-column TaskForm below `sm`, main gutter aligned to header.
- **Typeset/polish (P3, incl. issue-17 cost surfaces):** `tabular-nums` on all numeric surfaces, right-aligned cost column, 150ms dialog entrance with reduced-motion guard.

Redesign-scale items proposed for approval, **not** applied (see report): inline feedback/toasts replacing `window.prompt`/`alert`/`confirm`; board column management for terminal states; EventStream virtualization.

Verified: typecheck, production build, and full test suite (92/92) pass. Two-axis review (standards + spec) run; all findings fixed except the P3 badge-size drift noted as opportunistic in the report.
