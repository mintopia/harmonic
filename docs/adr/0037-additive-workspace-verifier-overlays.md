# Decision: Additive, id-keyed workspace verifier overlays

Status: accepted
Date: 2026-09-19

## Context

A Workspace's verifier lists (command verifiers and agent critics, per stage —
ADR-0003, ADR-0028) currently override the global list by **whole-array
replacement**: `null` inherits the global list, a non-empty array replaces it,
`[]` runs nothing (`setting-override.ts`, and the "list-grain whole-array
override" ADR-0022 preserved from ADR-0009). This means a Workspace that wants
to add one local check must copy every global verifier into its own list, and a
later change to a global verifier never reaches that Workspace.

ADR-0022 already made `harness.models[]` **id-keyed** — the Workspace patch is
per-id, and a new global model flows in automatically rather than being
tombstoned — while deliberately leaving verifier lists on whole-array override.
The operator now wants verifier lists to behave additively, like models: a
Workspace's verifiers are the global list **plus** its own, with the globals
shown but not editable, reorderable within the Workspace, and individually
disable-able.

## Decision

- **Verifier lists become additive, id-keyed overlays**, superseding the
  whole-array override for the six lists (task pre/post-merge, epic pre-merge ×
  commands + critics). This extends the id-keyed precedent ADR-0022 set for
  `models[]` to verifiers.
- **Every global command and critic carries a stable `id`.** Critics already
  have an operator-facing `name` (ADR-0031); `name` is not guaranteed unique, so
  identity is a separate `id`. Command verifiers gain an `id` (they have no other
  stable key — argv can repeat). Ids are assigned by a config migration.
- **The stored Workspace value is an ordered overlay**, not a replacement array.
  Each entry is one of:
  - `{ ref: <global id>, enabled }` — a global verifier, reorderable and
    disable-able, never editable from the Workspace.
  - `{ local: <verifier with its own id>, enabled }` — a Workspace-added
    verifier, fully editable.
  `null` still means "inherit all globals in global order". Stored as JSON in
  the existing `string | null` columns; no new columns.
- **Resolution merges** (`setting-override.ts`): walk the overlay in order,
  resolving `ref` entries against the current global list by id (a `ref` whose
  global no longer exists is dropped), inlining `local` entries, and skipping
  disabled entries. **Any global not named in the overlay is appended, enabled**,
  at the end — a newly-added global check reaches customised Workspaces rather
  than being silently missed. Resolution returns the same `{ commands, critics }`
  shape it does today, so every runtime consumer (command verifier, critic
  runner, `unpricedModelsForCostCap`, `verifyChannelsUnconfigured`) is unchanged.
- **UI**: the global scope editor is unchanged. The Workspace scope editor
  renders global rows locked, labelled "Global", reorderable (@dnd-kit, ADR-0031)
  and with an enable toggle; local rows are fully editable through the existing
  `EntryList`; "+ Add" appends a local entry. The shared env editor
  (`EnvEditor`) is reused for a local command's environment.

## Consequences

- A config migration assigns ids to existing global verifiers, and converts
  existing Workspace override arrays to overlays of all-`local` entries — which
  preserves today's exact resolved behaviour for every Workspace.
- `website/src/openapi.json` is regenerated for the new `id` fields and the
  overlay schema, per ADR-0011.
- Disabling is an explicit tombstone on a `ref`, unlike `models[]` (which has no
  disable); the two id-keyed patches stay distinct shapes on purpose.
- The whole-array override path is removed for these six lists; no Workspace can
  express "replace the globals entirely" any more, only disable each one.

## Supersedes

Partially supersedes ADR-0022 (the "command verifier keeps its ADR-0009
list-grain whole-array override" clause) and the corresponding ADR-0009
list-grain override, for the six verifier lists only. ADR-0022's model-catalog
id-keyed layering and all other override semantics stand.
