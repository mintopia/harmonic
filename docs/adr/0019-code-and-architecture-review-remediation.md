# Decision: Code & architecture review remediation

Status: accepted
Date: 2026-09-01

Tracked in GitHub epic **#444** ("Code & architecture review remediation"); the
child tickets below are its sub-issues.

## Context

On 2026-09-01 Harmonic went through a full code & architecture review: eight
parallel review passes (backend, frontend, reliability & security,
over-engineering, change-risk/CRAP, and three UX lenses), a live drive of a
seeded instance, and archify system diagrams. The review report is a
standalone HTML artifact and is **not** part of the repository, so this ADR is
the durable in-repo record of its findings and what we decided to do about
them.

The read, by area:

| Area | Grade | Summary |
|---|---|---|
| Architecture | A− | Real policy/mechanism separation; one `Runner` god-object and a few layering inversions pull it down. |
| Leanness (YAGNI) | A | Almost no speculative abstraction; ~30 lines and zero deps to cut. |
| Reliability & security | B+ | No injection in scope, tested secret redaction, sound concurrency; the merge mutex is held too long on conflicts, plus two small security gaps. |
| Coverage | C+ | 68.9% overall; the frontend component layer has no unit tests. |
| UI / UX | C | Thoughtful operator tooling; identity fragmentation, keyboard/a11y and contrast gaps. |

The codebase is well above the median for its size and age. The risk is
concentrated, not diffuse, and nothing calls for new frameworks — the fixes are
decompositions, tighter locking, and a first pass of component tests, each
sized to the code that already exists.

## Decision

**Remediate the findings via epic #444**, as `ready-for-agent` child tickets
across four areas: Architecture, Code quality, Reliability, and UI/UX. The
tickets and their acceptance criteria are the sub-issues of #444.

**Accept, do not schedule, the two security findings** flagged by the review:

1. **Tracker `Path:` traversal** — the local-markdown tracker honours an
   absolute `Path:` verbatim, letting Harmonic read/write `NN-*.md` outside the
   repo root.
2. **Critic 2-key denylist** — the critic and command-verifier build child env
   as `{...process.env}` minus two names, so other ambient daemon secrets
   (`GH_TOKEN`/`GITLAB_TOKEN`) reach a tool-capable critic that reviews
   attacker-influenced content.

Both are accepted as **residual risk by the owner** for the current
single-operator deployment and are recorded here so a future security audit
does not re-flag them as unseen. If the deployment model changes (shared or
multi-tenant operation), they should be reopened: clamp `Path:` to the repo
root, and build the critic env from an explicit allowlist.

## Remediation scope (epic #444 children)

Architecture:

- Decompose the `Runner` god-object and the `driveOnce` mega-method (Critical).
- Fix the `domain→execution` layering inversions (High).
- Move business logic out of the tasks HTTP route (`parseUnifiedDiff`,
  `liveWorktreeDiff`) (Medium).
- Split `serialize.ts` into a read-model layer and pure DTO mappers (Medium).
- Extract TicketPage data hooks (High).
- Extract a ConversationLauncher conversation-detail hook (Medium).
- Low-priority code-health cleanups (AppContext threading, concrete `Git`
  coupling, `epic-*` naming, fetch-guard boilerplate, `App.tsx` render size,
  ACP `any`) (Low).

Code quality:

- Render/smoke tests for `App.tsx` and `StatsPage.tsx`, the two highest
  change-risk components.
- Delete `ConfigStore` and the single-implementation `StatsReader` interface.
- Unify `ui.ts` state-colour so `done` stops rendering two greens.

Reliability:

- Narrow the merge-mutex hold window: release the repo lock around each agentic
  conflict-resolution turn (High).

UI / UX:

- Unify ticket identity — show both IDs (`#436 · T-430`) everywhere (High).
- Make Board task cards keyboard-reachable (High, a11y).
- Accessibility & copy sweep: state-chip AA contrast, first-run banner and
  cost-label copy, `blocked` vocabulary, mobile status strip, landmarks,
  `prefers-reduced-motion`, tap-target minimums (Medium–Low).

## Consequences

- The review's findings survive the disposable report as tracked, runnable
  work with acceptance criteria.
- The two accepted security gaps are documented residual risk with a clear
  reopen trigger (a change in deployment model), not silent omissions.
- No new architecture is introduced; the remediation is decomposition,
  containment, and test coverage within the existing shape.
