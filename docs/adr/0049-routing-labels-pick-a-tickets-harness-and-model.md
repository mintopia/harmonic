# Decision: Routing Labels pick a Ticket's Harness and Model

Status: accepted
Date: 2026-10-07

An operator maps tracker labels to a Harness + Model (`reasoning` → Claude,
Opus 5.5) so a mirrored Ticket's execution settings follow how the issue is
labelled. The route is resolved live at every Attempt start, Epics route by
their own labels, and Critics are never routed. Every Critic has its own
Harness and Model (#830).

## Context

A mirrored Task is created with no Harness or Model and inherits the Workspace
default, else the global default. The only per-Ticket choice was an operator
editing the Ticket in Harmonic, which does not scale to a tracker-driven board
where the person filing the issue knows whether it needs a strong or a cheap
Model.

## Decision

- **A Routing Label is a label → (Harness, Model) mapping.** The entry shape is
  extensible; Harness and Model are the only settings it carries for now.
- **Ordered list, first match wins.** An issue carrying several Routing Labels
  takes the first in list order. The Ticket shows which label decided. Labels
  match case-insensitively and are unique within the resolved list.
- **Global list, additive Workspace overlay**, following ADR-0037: a Workspace
  reorders or disables global rows and adds local ones, never edits a global
  row. A local row may not duplicate an enabled global's label; to remap, the
  Workspace disables the global row. A new global reaches customised Workspaces.
  Configured on Settings › Execution beside the Task defaults.
- **Precedence**: an operator's explicit setting on the Ticket, then the Routing
  Label, then the Workspace default, then the global default.
  All-or-nothing: a Routing Label applies only when the operator has set neither
  Harness nor Model on the Ticket. Setting either one disables the route
  entirely; it never fills in the other field.
- **Re-resolved at every Attempt start.** Relabelling an escalated Ticket and
  retrying runs the next Attempt on the new route. An Attempt in flight is never
  re-routed. A Harness change cannot reuse the warm Session (session-resume
  rejects a Harness mismatch), so the next Attempt starts a fresh one; a
  Model-only change keeps it. The Activity view records the switch.
- **No silent fallback.** Saving a mapping whose Harness is not configured is
  refused. If a route's Harness is unavailable at Attempt start, the Ticket
  escalates naming the Routing Label rather than falling back to a default.
  Model ids are not validated; the catalog is open (ADR-0022).
- **Epic-level turns route by the Epic's own labels**, else the defaults. They
  stop borrowing the Harness and Model of whichever member Task happens to be
  working. The more specific source wins (amended by #834): the Epic's operator
  Harness/Model override, then the label snapshot on the Epic's Task row, then
  the one on its tracker container row, then the defaults. An override replaces
  the label, as it does for Tickets.
- **Critics are never routed, and every Critic has its own Harness and Model
  (amended by #830).** There is no fallback to the Workspace or global default
  Harness, and never the Task's Harness. A Critic's Model must be in its
  Harness's model list: saving a Critic whose Model is not in that list is
  rejected with a 400 naming both. On config load, a Critic without a Harness
  is migrated to the one Harness whose model catalog lists its Model. If none
  or several match, the global default Harness is used and a warning naming
  the Critic is logged. No Critic is dropped.
- Native Tasks carry no labels and are never routed.

## Considered Options

- **Freeze the route at the first Attempt.** Rejected: relabel-and-retry onto a
  stronger Model is the main workflow this enables; the cost is a cold Session
  on a Harness change.
- **Fall back to the next label or the default when a route breaks.** Rejected:
  it silently changes Cost and capability.
- **Routing table in a repo file, like Triage Labels.** Rejected: Model choice is
  an operator cost decision, not something a merged doc should change.
- **Whole-list Workspace replacement.** Rejected for the ADR-0037 reasons: a
  customised Workspace would silently miss new globals.

## Consequences

- Epic resolve, refresh and integration-merge turns change behaviour: they no
  longer follow a member Task's settings.
- A Critic without its own Harness is migrated on config load (see Decision). The #818 fallback to the Workspace/global default Harness is replaced (#830).
- Retry offers a Harness and Model picker that saves both as operator settings on the Ticket (#817); the Routing Label then no longer applies (#826).

## Supersedes

None. Extends ADR-0037 (overlay shape) and ADR-0022 (Model catalog).

Amended by #830: the Critic Harness fallback clause (#818) is replaced by the
own-Harness rule in Decision. Model ids remain unvalidated for Tasks; the
Critic Model check applies only to Critics.
