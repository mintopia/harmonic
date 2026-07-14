# Design audit and polish pass (impeccable)

Status: ready

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
