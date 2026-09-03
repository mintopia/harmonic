# Decision: A root ticket with children is a structural Epic, no label required

Status: accepted
Date: 2026-09-03

Amends ADR-0016 (see "Amends" below).

## Context

ADR-0016 made the `epic` label (or `wayfinder:map`) load-bearing for Epic
identity: "a ticket that groups work must carry `epic`". Two derivations grew
apart under that rule:

- The mirrored-Task layer (`TaskService.isEpic`) already treats a **root ticket
  that is a parent of other work** as an Epic — no label needed — and marks it
  non-agent-workable. The Board's `isDriver` suppresses such a ticket's own card
  and groups its children beneath it.
- The stored-Epic enumeration (`deriveStoredEpics` → the `epics` table, ADR-0018's
  single enumeration source) still required the label. So an unlabelled root that
  groups work was an Epic to the Task layer but invisible to `listEpics`, the
  Epic view, and Board epic grouping.

Observed live (MP Soloist workspace): ticket 1 owns a set of children and has no
parent, yet was not picked up as an Epic — its children showed as loose
standalone work instead of an Epic band, because ticket 1 carried no `epic`
label.

## Decision

Being the top of a work tree is enough. `deriveStoredEpics` now enumerates a
leaf-most container as a stored Epic when it is either label-identified (a Map or
an `epic`-labelled Epic) **or** a **structural Epic**: a root ticket
(`parent == null`) that has ≥1 child. This aligns the enumeration with the
`isEpic` flag the mirror already sets, so a root container is an Epic everywhere.

A structural root Epic is **not** demoted into `tracker_containers` — it stays a
mirrored Task (as ADR-0016's `isEpic` root Tasks already did); the Board's
`isDriver` suppression, not container demotion, keeps its card from doubling up
with its Epic band. The `epic` label / `wayfinder:map` remain the identifiers for
**nested** containers (a container that has its own parent): a bare mid-spine
parent without a label is still not an Epic.

## Consequences

- Fixes the "root ticket with children isn't picked up as an Epic" gap without
  requiring operators to tag every top-level grouping ticket with `epic`.
- The `epic` label stays load-bearing only for **nested** epic-type containers;
  root containers no longer need it.
- Structural root Epics remain mirrored Tasks (unlike labelled Epics, which are
  demoted to containers). The delete/tombstone protection ADR-0016 sought comes
  from `isDriver` card suppression rather than container demotion.

## Amends

ADR-0016 (Epics are label-driven containers): relaxes "a ticket that groups work
must carry `epic`" — a **root** grouping ticket is a structural Epic without a
label. The label requirement stands for nested sub-containers.
