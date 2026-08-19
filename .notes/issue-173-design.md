# Issue #173 — operator UX design record (Epic display, verification, run completion)

Grilling outcome for the `wayfinder:grilling` task #173. Captures the decisions,
the as-built audit, and the downstream ticket plan.

## Reframe (corrects the issue's premise)

#173 assumed Surfaces 2 & 3 were absent. They are **built** on `develop`
(#168–171 CLOSED): `VerificationCard`, global `VerificationFields` + workspace
`InheritField` overrides, `PhaseTimeline`, guardrail-trip banner + lease
skip-reason, and `RejectDialog`'s continue-full/condensed choice all exist. The
**genuine gap is Surface 1 — the parallel-Epic UI**, which has zero frontend
(#167 OPEN). So the work splits: **build** the Epic UI; **ratify + fix** the
rough edges on 2 & 3. The closed tickets can't be worked directly → fixes land as
new tickets.

Domain vocabulary added to `CONTEXT.md` ("Parallel Epic execution" cluster).
Architecture recorded in **ADR-0026**.

---

## Surface 1 · Epic UI (build — #167)

- **Representation**: Table group-by-Epic bands + Board Epic-chip (mirrors the
  `mapTitle` chip) + Epic focus-mode (filter Board to an Epic's members + pinned
  summary). No new rail — an Epic is a derived, workspace-scoped roll-up.
- **Rich Epic peek** (Modal mirroring `TaskDetail`), opened from band header / chip.
- **Peek IA**:
  - *Hero* = **landing rail**: members as segments coloured by land status
    (landed / running / healing / waiting / blocking) + status line
    `epic/<ref> @ <tip> · verification ✓/✗ · X/Y folded`. Pulse only for a live heal.
  - *Roster* = **lane-grouped, stuck-first**: Stuck → In flight → Waiting →
    Landed; rows deep-link to the member's existing `TaskDetail`.
- **Force-land**: `ArmedButton` (arm→confirm) in band + peek header with
  consequence text; result = transient banner over the 6 `EpicLandOutcome`
  states (`landed | blocked | waiting | escalated | noop | busy`).
- **Data**: new read endpoint `GET …/epics` + `…/epics/:ref` (server composes
  `deriveEpics` + `reduceMemberState` + branch/coordinator state); client
  refetches on the `task_changed` firehose poke. Dedicated train events = fast-follow.

## Surface 2 · Verification (ratify + fix — refs #109)

As-built audit findings and agreed fixes:

- **#1 (blocker) — verdict invisible at the review gate.** Accept sits in the
  footer; the critic verdict hides in an un-flagged Details tab, so a `block`/
  `inconclusive` Run can be Accept-merged blind. **Fix**: light the Details
  flag-dot on a *verdict* (not just feedback); inline a one-line verdict summary
  in the review-gate footer; make **Accept arm/confirm** when the verdict is
  `block`/`inconclusive`.
- **#2 — critic harness hidden & pinned; model unvalidated free text.** **Fix**:
  harness **select** (default "Same as task") + model **select** (reuse
  `ModelCombobox`), global + workspace; free-text fallback only where a harness
  can't enumerate models.
- **#3 — workspace can't turn a global verifier OFF** (`InheritField` binary;
  override-to-empty fails `min(1)`). **Fix**: explicit **Enabled switch** per
  workspace verifier override → tri-state inherit / off / override.
- **#4 — verdict card legibility.** **Fix**: group self-heal retries under their
  mechanism with attempt numbers + a "self-heal" tag; add a "verification
  pending" state; add a non-colour icon per verdict (colourblind safety).

## Surface 3 · Run legibility & Sessions (ratify + fix — refs #106 / #110)

- **#5 — reject continuation cost mis-signalled** (cold ≡ unknown; warm/cheap is
  the only highlighted band; condensed shows no cost). **Fix**: cost-semantic
  band colouring (cold = amber "pricier" · warm = calm · unknown = plain) + a
  qualitative label for **Start condensed**. A real condensed estimate is a
  backend follow-up in `planSessionContinuation`, not blocking.
- **Polish batch** (log, don't design): unify the dual guardrail-trip rendering
  (header banner vs `EventStream` text line); hoist the one-time progress-nudge
  to a header-level mark; distinguish phase-timeline "gap" vs genuinely-unreached
  steps + show per-phase durations; link the lease skip-reason to the blocking
  lease owner / Activity Leases panel.

---

## Ticket plan

The closed #168–171 can't be worked directly → fixes land as new tickets.

### Rewrite #167 (OPEN) → ready-for-agent
`parallel-epic(web): Epic UI — board bands + Epic peek + force-land, over a new read endpoint`
Body: the full Surface 1 design above. Note it is **backend + frontend** (adds
the `GET …/epics` read endpoint), not UI-only. Per ADR-0026.

### New: `verification(web): UX hardening — verdict-at-gate, critic harness/model, workspace-off, card legibility` (refs #109)
Findings #1–#4 above.

### New: `sessions(web): reject continuation cost signal — symmetric + cost-semantic` (refs #110)
Finding #5 above.

### New: `reliability(web): run-legibility polish — unify guardrail-trip, hoist nudge, phase durations, lease link` (refs #106)
The polish batch above.

---

## Artifacts
- `CONTEXT.md` — Parallel Epic execution glossary cluster (done).
- `docs/adr/0026-parallel-epic-operator-ui.md` (done).
- `.scratch/epic-force-land-explainer.html`, `.scratch/epic-peek-mockups.html` —
  session aids (landing-rail hero + lane-grouped roster mockups).
