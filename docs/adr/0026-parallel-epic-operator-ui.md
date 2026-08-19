---
Status: accepted
---

# Parallel Epic operator UI: board-hosted bands + a rich Epic peek, over a derived read endpoint

ADR-0024 built the parallel-Epic backend (integration branch + merge train +
whole-Epic land) but shipped with **only a `force-land` endpoint** — no read
model and no UI. The operator cannot see or drive an Epic from the web app. This
ADR records how the Epic is surfaced and driven, and where its data comes from.

We chose to keep the Epic **inside the workspace board** rather than give it a new
top-level rail, because an Epic is a *derived, query-time roll-up* (ADR-0024
stores no grouping entity) and is workspace-scoped — it is not a first-class
board citizen deserving its own global nav. Its members already are task cards.

## Decision

- **Representation = board-hosted, not a new rail.** Epic-child Tasks group into
  collapsible **group-by-Epic bands** in the Table view (grouping is native to a
  flat list and fights the Board's per-state Kanban columns); the Board keeps
  flat state columns but each member card carries an **Epic chip** (mirroring the
  existing `mapTitle` chip on `MirroredCard`) that opens the Epic peek, plus an
  **Epic focus-mode** that filters the Board to one Epic's members with a pinned
  summary. No entry is added to `VIEWS`/`VIEW_LABELS`.

- **The rich surface is a peek** (a Modal mirroring `TaskDetail`), opened from the
  band header or the Board chip — not a persistent view.

- **Peek IA: the merge-train landing state is the hero.** A **landing rail** —
  members rendered as segments coloured by land status (landed / running /
  healing / waiting / blocking), above a status line
  `epic/<ref> @ <tip> · verification ✓/✗ · X/Y folded`. Motion (a pulse) is
  reserved for the single genuinely-live thing, a heal in progress. Below it a
  **member roster**, lane-grouped **stuck-first** (Stuck → In flight → Waiting →
  Landed) so what-needs-you sits next to the force-land control; each row
  deep-links into the member's existing `TaskDetail`.

- **Force-land is an armed operator action.** An `ArmedButton` (arm → confirm)
  in the band header and peek header, with consequence text ("lands the members
  already folded in; a stuck sibling stays behind; Verification still gates").
  Its result is surfaced as a transient banner mapping the six `EpicLandOutcome`
  states (`landed | blocked | waiting | escalated | noop | busy`) to a plain
  sentence and a state tone.

- **Data source = a new server-side read endpoint.** `GET …/epics` and
  `GET …/epics/:ref` compose the pure derivations (`deriveEpics` +
  `reduceMemberState`) with the server-only integration-branch tip and
  merge-train/coordinator state; the client refetches on the existing
  `task_changed` firehose poke.

## Considered options — data source

- **Client-side derivation** from the streamed member Tasks (the firehose already
  carries every `task_changed`, and `web` already mirrors domain models such as
  `verification-model.ts`). *Rejected:* the integration-branch tip and live
  merge-train state are server-only, so the **hero** — the very reason the Epic
  UI exists — would be the least reliable thing on the screen, inferred rather
  than known.
- **Read endpoint (chosen).** Accurate hero, contained backend addition, adequate
  liveness via refetch-on-poke.
- **Read endpoint + dedicated `epic_changed`/train-transition firehose events.**
  Truly real-time train. *Deferred* as a fast-follow if refetch-on-poke feels
  laggy — not paid up front.

## Consequences

- Issue #167 ("Epic view + force-land") is **not UI-only**: it now carries a
  backend read endpoint alongside the frontend. Force-land already exists
  (ADR-0024); the read model is the new server work.
- The Epic peek is a net-new component; there is no member-detail surface to
  build — rows reuse `TaskDetail`.
