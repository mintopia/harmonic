# Decision: The local DB is the source of truth for agent work; the tracker is a normalising I/O peer

Status: accepted
Date: 2026-08-21

## Context

Harmonic sits on top of the Matt Pocock engineering skills: `to-tickets` breaks a
plan into tracer-bullet tickets and stamps each `ready-for-agent`; a **wayfinder
map** (`wayfinder:map`) is a parent issue with typed children. An **Epic is the
set of tickets from a single `to-tickets` call**, detected structurally through
the shared `parent` ref (GitHub sub-issue / `Part of #n`, GitLab epic, local
`spec.md` sibling).

Today "is Harmonic working on this?" is *inferred* from the GitHub `@me` assignee,
and epic/ready structure is re-derived every poll from the ephemeral last scan
(`deriveEpics(poller.tickets())`). Two subsystems read the assignee with
contradictory meaning — `isReady` ("any assignee ⇒ not ready") vs `foreignAssignee`
("non-@me ⇒ foreign") — and integration-branch liveness is a per-poll set
(`liveIntegrationRefs`) standing in for "does the branch exist." A failed epic
member keeps its own claim, which empties the ready frontier, which is the only
thing that re-marks its branch live, so it can never be re-picked and never
escalates (observed live: epic 201 / #208 / task 206). The assignee is also the
least portable field: local-markdown has none, so assignee-gating is already
vacuous there and means different things on each tracker.

The root cause is inferring execution ownership from external, mutable tracker
state instead of *knowing* it locally.

## Decision

1. **The local DB is the source of truth for execution state** ("are we working
   this, and in what run?"). The tracker is the source of truth for *inbound
   facts only*: lifecycle state, `parent`, blockers, labels, title, body. The poll
   upserts those facts onto the per-issue record; epic/map derivation, the ready
   frontier, and priority all read the **DB**, not the live scan — durable across
   restart, single-sourced.

2. **Eligibility is the `ready-for-agent` signal, never assignment.** A ticket is
   pick-eligible when it is `open`, carries `ready-for-agent`, has no open blocker,
   and is not already worked locally. The tracker assignee is **not read at all**.
   The signal is adapter-normalised into `Ticket.labels[]` (GitHub/GitLab native
   label; local-markdown maps its `**Status:**` line), read via a shared
   `READY_FOR_AGENT` constant — the same pattern as `MAP_LABEL`/`isMap`. This is
   also *more correct* than parent-structure: it excludes a map's interactive
   children (`wayfinder:research`/`grilling`/`prototype`) that structural
   derivation would wrongly treat as runnable.

3. **Ownership is a local column, not a GitHub claim.** Claiming a ticket is the
   local `ready → running` transaction (the real lock); releasing it is a local
   state transition. No `@me` assignee is read to learn whether *we* are running
   something. `@me` may still be *pushed* outbound as a courtesy advertisement,
   never read back.

4. **Scheduling is self-driven off the DB.** On an interval *or* on freed
   capacity, the scheduler queries the DB for the highest-priority eligible task,
   claims it locally, and runs it. The poll becomes a pure fact-sync sidecar; it no
   longer drives picks. A slow poll can no longer delay a pick, and a wedged pick
   can no longer be blamed on the poll.

5. **Priority is a DB-owned field**, ordered: explicit priority (native tickets
   set it; mirrored tickets carry a nullable augmented value) → topological
   (unblocked-first, then unblock-count) → age (created date / number). The pick is
   one DB query with no tracker read.

6. **Status is bidirectional, gated by adapter capability.** Harmonic pushes
   lifecycle on verified transitions and **accepts inbound changes it didn't
   originate** (a human `reopen`, or removing `ready-for-agent`, is truth). An
   inbound close while a Task still runs is premature → reopen + escalate
   (ADR-0021 / #139). Push is uniform across the three first-class trackers —
   local-markdown gains open/close write (a deliberate change from its prior
   read-only contract; premature-close there is detected as "still-running +
   now-closed", no edit author needed). A freeform "Other" tracker that cannot
   write degrades to inbound-only.

7. **Non-pickup is always legible.** Every eligible-but-unpicked task carries a
   current, surfaced skip reason (`blocked-by #N`, `at capacity`, `integration
   branch missing`, `git-backoff`, `workspace disabled`, `hitl`). A skip reason
   that cannot self-resolve **escalates** rather than looping — no silent or
   self-contradicting waits (the #208 "retry shortly" that never came).

## Consequences

- **Dissolves the assignee side-channel from the read path.** `isReady`'s "any
  assignee" rule, `foreignAssignee`, and the `@me` claim/release *reads* all go.
  Seams B (one bit, two meanings) and C (release trigger downstream of the block)
  cease to exist.
- **The integration-branch gate keys on ground truth.** `memberBaseNotReady`
  becomes a direct `git rev-parse epic/<ref>` at spawn, not `liveIntegrationRefs`.
  The frontier can no longer empty from a held claim, so the #208 deadlock class is
  gone; the detached-HEAD flap (gating all members when an unrelated direct Run
  detaches HEAD) goes with it.
- **Portability improves.** Everything the scheduler reasons over
  (labels/parent/blockers/state/isMap) is already normalised at the
  `TrackerAdapter`/`Ticket` seam, so no tracker-specific logic reaches the domain.
  Dropping the assignee *unifies* trackers rather than costing anything (it was
  vacuous on local).
- **Explicit divergence from upstream, accepted knowingly.** The wayfinder/`to-tickets`
  contract treats `assignee = claim` (its frontier drops assigned tickets; claim is
  `add-assignee @me`). This ADR replaces that with `ready-for-agent` + local DB, and
  the human-reclaim contract becomes **remove the `ready-for-agent` label, do not
  just assign yourself**. This assumes **Harmonic is the sole agent-executor of
  `ready-for-agent` tickets** for a repo; running the raw skills alongside Harmonic
  and claiming the upstream way (assign-self, label left on) would collide. The
  reclaim contract must be documented where humans will see it (the tracker setup /
  `docs/agents`).
- **The "Epic = one `to-tickets` call" proxy has a universal gap:** a batch created
  without a source parent issue has no `parent` ref (every tracker), so it is
  ungroupable and falls back to per-run. Recorded, not fixed.
- **Tension with ADR-0017 accepted deliberately.** 0017 keeps *tracker resolution*
  out of the DB because it recomputes cheaply on boot. Ticket facts are different:
  external mutable state the scheduler must act on even when a poll is slow or
  failed. The poll stays the freshness bound; a persisted last-known-good beats an
  in-memory scan lost on restart, and staleness self-corrects on the next poll.
- Requires a migration (fact columns + priority + skip-reason) and a scheduler
  decoupled from the poll poke; the local-markdown adapter gains status writes.
- **Step one, ships immediately:** flip eligibility from "any assignee" to the
  `ready-for-agent` label, and gate the integration branch on `git rev-parse`. That
  alone clears the live deadlock class; the rest lands incrementally under this ADR.

## Supersedes

None. **Refines ADR-0024** on two points — eligibility (`ready-for-agent`, not
"no assignee") and derivation source (persisted DB facts, not the live scan). On
acceptance, add a "Refined by ADR-0030" note to those two lines of 0024; its
integration-branch and merge-train decisions stand unchanged.
