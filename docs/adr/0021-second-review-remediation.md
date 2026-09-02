# Decision: Second code, architecture & product review remediation

Status: accepted
Date: 2026-09-02

Tracked in GitHub epic **#460** ("Code, architecture & product review (2)
remediation"); the child tickets **#461–#473** are its native sub-issues.

## Context

On 2026-09-01 Harmonic went through a **second** full review — code,
architecture, and now product — taken after epic #444 (ADR-0019) closed all 14
of its remediation tickets. Eight parallel review passes plus a live UX drive
and archify diagrams re-graded the codebase against the code, `PRODUCT.md`, the
definitive ADRs, and the public docs. As with ADR-0019, the review report is a
standalone HTML artifact and is **not** in the repository, so this ADR is the
durable in-repo record.

Grades by area:

| Area | Grade | Note |
|---|---|---|
| Architecture | B | Layering fix from #444 held; two decompositions stopped a third of the way in and a new god-object grew in `src/tracker`. |
| Leanness | B+ | Little speculative abstraction; a verdict fork, a legacy config shim, dead exports, and stale ADR citations to cut. |
| Security | B− | The two ADR-0019-accepted findings persist (accepted); shipped defaults remain unsafe for a stranger (owner-deferred). |
| Coverage | B− | 75.5% overall (was 68.9%); the React component layer still holds the change-risk and the top CRAP scores at 0%. |
| UX | B− | One CRITICAL a11y defect (charts empty to a screen reader); duplicate id, contrast, and progress-bar honesty gaps. |
| Product | B− | Several surfaces misreport the current unconfigured state; docs and shipped defaults describe a product only the author gets. |

Every surviving finding was **re-verified against current `develop`** (`2154e62`,
~10 commits past the report's `7d81baf`). Four were already fixed and dropped
(Epic-page live-update, Board all-clear state, failed-Attempt reason
persistence, and epic tracker auto-close — `src/tracker/epic-close.ts`
already closes an integrated epic idempotently). Three report magnitudes were
overstated but true in substance and were corrected in the tickets (`driveOnce`
is 562 lines not 946; `buildApp` ~540 not 740; dead ADR citations ~154 across
77 code files, not 443/93).

## Decision

**Remediate the live findings via epic #460**, as `ready-for-agent` child
tickets across architecture decomposition, frontend structure, test coverage,
honesty, reliability, and accessibility. The tickets and their acceptance
criteria are the sub-issues #461–#473.

**Out of scope, by owner decision** (recorded here so a later review does not
re-flag them as unseen):

1. **Shipped config default *values*** (`isolationMode`, `review.enabled`,
   `mergeFate`, CLI host) and the **settings-surface trim** — a separate
   planned config track. The review's top finding (a fresh install auto-merges
   unverified work) is therefore not scheduled here; the operator's own
   `settings.yaml` overrides these today. The *honesty* half — surfaces that
   misreport the current unconfigured state — **is** scheduled (#470), because
   it is a "Honest numbers" defect, not a default change.
2. **Docs-site regeneration** and **`develop→main` promotion** — separate
   tracks.

**Re-flagged but still accepted** (unchanged from ADR-0019): the tracker
`Path:` traversal and the critic two-key env denylist remain **accepted
residual risk** for the current single-operator deployment. Review (2)
re-flagging them does not reopen ADR-0019's decision; its reopen trigger (a
shared or multi-tenant deployment model) still stands.

**Won't-fix** (owner decision): session-store hardening (single-operator auth →
config/auth track) and the sub-390px mobile Tasks-table layout (`PRODUCT.md`
frames Harmonic as a desktop side-monitor tool).

**Schema-sync keeps the ADR-0007 clean-break policy** (#471): no database
backup is introduced. A destructive schema convergence runs in one transaction
and, on failure, rolls back to the loud clean-break recreate; it logs the
dropped objects by name. A backup/rollback scheme, if ever wanted, is a
separate ADR.

## Remediation scope (epic #460 children)

Architecture:

- Finish the `driveOnce`/Runner decomposition (`TurnListeners` + per-drive
  `TurnState`) (#461).
- Extract an `EpicService` out of the new `TrackerPollerManager` god-object
  (#462).
- Decompose `buildApp` into sub-context factories and split `TaskService`
  (`TaskBlockerGraph` + `TaskMirror`) (#463).
- Backend ports & typing: diff-out-of-route, harness registry breaking the
  import cycle, Epic-coordinator merge, one shared ACP permission parser (#464).

Frontend:

- Split `TicketPage` into `components/ticket/` (#465, blocked by #469).
- WebSocket reconnect re-hydrate + bounded backoff (#466).
- Plumbing: `AppContext`, `useLiveEffect` migration, dedupe `Fact` (#467,
  blocked by #465).
- Wire-contract safety (`Task` vs `ApiTask`, directional) + port the
  source-text tests to the render harness (#468).

Coverage & reliability:

- Frontend coverage floor + smoke tests + suite health (#469).
- Honesty gate: surface the existing `disabled` verifier state, gate the
  progress bar on attempt evidence, fire the ungated-server warning (#470).
- Crash recovery (isolated harness process groups, verified pid identity) + a
  transactional schema-sync (#471).

UX & cleanup:

- Accessibility sweep, holding the one CRITICAL (`role="table"` charts) (#472).
- Prose & dead-code sweep (stale citations, verdict fork, legacy shim, dead
  exports, `Run` copy) (#473).

## Consequences

- The second review's findings survive its disposable report as tracked,
  runnable work with acceptance criteria, verified live against `develop`.
- The deferred config posture, the two re-accepted security findings, and the
  two won't-fix items are documented owner decisions with clear triggers, not
  silent omissions.
- No new architecture is introduced; the remediation is decomposition,
  containment, honesty, and test coverage within the existing shape.
- The plan was hardened by a five-round adversarial cross-model review (Codex,
  read-only) before creation; the transcript is retained with the working
  artifacts.
