# Decision: Reorderable, named verifier lists with @dnd-kit

Status: accepted
Date: 2026-09-11

## Context

The global and per-Workspace verification settings edit two ordered lists per
stage — command verifiers and agent critics (ADR-0003). Order is meaningful
(verifiers run top-to-bottom), but the editor offered no reordering, stacked
each critic as an equal-weight bordered block, and a critic had no glanceable
label — the two big prompt textareas were the only way to tell critics apart.

The rework turns both into an ordered list of collapsible entries: a scannable
row per verifier, click to edit in place, drag to reorder. A critic needs a
short human label for its row. A hand-rolled pointer reorder was tried first and
rejected in review — it had no element under the cursor while dragging and no
accessible path — with the owner directing that a real drag-and-drop library be
used instead.

## Decision

- **Adopt `@dnd-kit`** (`@dnd-kit/core`, `@dnd-kit/sortable`,
  `@dnd-kit/utilities`) as the drag-and-drop library for the web app. It is the
  maintained, accessibility-first standard for React 19: a grip is the only drag
  handle, a `DragOverlay` carries a copy of the row under the cursor, and a
  keyboard sensor gives a full non-pointer reorder path. Rows carry stable
  per-item ids kept in lockstep with the array so a drop settles into place.
- **One shared `EntryList` component** owns the ordered/collapsible/reorderable
  pattern, so the critic and command editors render through it and cannot drift.
- **Critics gain an operator-facing `name`**, added to the shared critic
  identity zod schema as `z.string().default('')` — additive, so it flows to
  both task and epic critics and needs no migration; a blank name renders as
  "Untitled critic". Command verifiers keep labelling themselves from their
  argv, so they gain the list/drag UX but no name field.
- Harness is chosen before model in the critic runtime fields, and the model is
  a datalist combo seeded from the chosen harness's catalog (ADR-0022).

## Consequences

- Three new runtime dependencies enter the web bundle (~30 kB gzipped). Accepted
  for a correct, accessible reorder that a hand-rolled version could not match.
- The generated `website/src/openapi.json` is regenerated for the new critic
  `name` field, per ADR-0011 (the schema change *is* the reason to regenerate).
- Reorder is keyboard-navigable, meeting the WCAG AA keyboard-path floor.
- Aligned with ADR-0003 (critic identity/config) and ADR-0011 (Paper design
  world, OpenAPI-from-zod); no verification semantics change.

## Supersedes

None.
