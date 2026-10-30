# Decision: A Route Classifier picks a Model Option when no operator setting or Routing Label applies

Status: accepted
Date: 2026-10-30

When neither the operator nor a Routing Label has chosen a Ticket's Harness and
Model, an AI decision, the **Route Classifier**, picks one **Model Option**
from an operator-defined closed list. It re-runs at every Attempt start, so a
failing Ticket can move to a stronger Model or another Harness. If it cannot
decide, it abstains and the Workspace default applies, visibly. Amends ADR-0049.

## Context

ADR-0049 lets the person filing an issue pick a Harness and Model by labelling
it. Most issues carry no Routing Label, so they run on the Workspace default
whatever their size: a one-line fix and a cross-cutting refactor cost and
perform alike. The information to tell them apart is already on the Ticket
(title, description, labels) and in its history (how the last Attempt failed).
Choosing per Ticket by hand does not scale on a tracker-driven board.

## Decision

- **Precedence**: an operator's explicit setting on the Ticket, then the
  Routing Label, then the Route Classifier, then the Workspace default, then
  the global default. ADR-0049's all-or-nothing rule still decides whether the
  operator setting applies; the Route Classifier is consulted only when neither
  the operator nor a Routing Label has decided.
- **A closed list of Model Options.** A Model Option is a Harness, a Model,
  and a description of when it fits ("cheap, small fixes"). The Route
  Classifier picks exactly one, by id, and never picks outside the list.
- **Global list, additive Workspace overlay**, following ADR-0037 as Routing
  Labels do. Each Workspace turns the Route Classifier on or off and chooses
  its backend. Configured on Settings › Execution. Saving a Model Option whose
  Harness is not configured is refused.
- **Inputs**: the Ticket's title, description and labels, the Attempt number,
  and the previous Attempt's verdict and failure reason.
- **Re-run at every Attempt start.** A retry can escalate to a stronger Model
  or switch Harness. A Harness change starts a cold Session, the same accepted
  cost as ADR-0049. An Attempt in flight is never re-routed.
- **Three backends, one setting**: (a) a TypeSafe decision model (the Jev
  family, via OpenRouter); (b) an OpenAI-compatible endpoint with structured
  output; (c) a configured Harness, run as a one-shot Session with no tool
  permissions, outside any worktree. Every backend returns `{optionId, reason}`,
  validated with zod.
- **Abstain, visibly.** On an error, a timeout or invalid output, the Route
  Classifier abstains and the Workspace default applies; the abstention is
  recorded in Activity. This is an advisory layer, distinct from ADR-0049's
  no-silent-fallback rule, which still governs a broken explicit route: an
  unavailable Routing Label Harness escalates.
- **Recorded on the Attempt it routed.** The decision and its one-line reason
  appear in Activity. Its Cost is a separate routing line on that Attempt. It
  is not a Step and adds no Step type.
- **Editable instructions, visible prompt.** The classifier's instructions are
  an editable prompt: a Prompt Fragment until the Prompt Library (ADR-0054)
  replaces Fragments, then a Prompt Library entry. The Resolved Prompt is
  visible, as ADR-0047 requires of every prompt Harmonic sends.
- **Scope.** Native Tasks are classified. Epics are not: an Epic resolves from
  its labels, then the defaults (ADR-0049). Critics are never classified.
- **Inside a Task Execution Workflow** (ADR-0053): an agent step with no
  explicit Harness or Model uses the Ticket's route; a step with explicit
  values, which every Critic has, ignores routing. The Route Classifier runs
  once per Attempt, not once per step.

## Considered Options

- **Let the classifier name any Harness and Model.** Rejected: Model choice is
  an operator cost decision; a closed list keeps the classifier from reaching
  for a Model the operator never budgeted for.
- **Classify once, at the first Attempt.** Rejected for the reason ADR-0049
  rejected freezing a route: moving a failing Ticket to a stronger Model on
  retry is the main thing this enables.
- **Re-classify each Attempt but lock the Harness after Attempt 1**, so only
  the Model can change and the warm Session always survives. Rejected: some
  failures need a different Harness, and the cold-Session cost of a switch is
  already accepted by ADR-0049.
- **Escalate when the classifier fails, as a broken Routing Label does.**
  Rejected: the classifier is advisory. Its failure says nothing about the
  Ticket, and the Workspace default is what the Ticket would have run on
  without it. The abstention is shown, so the default is never silent.
- **Record classification as a Step.** Rejected: it is a routing decision made
  before the Attempt's Steps run; Activity and the routing Cost line record it
  without a new Step type.
- **Classify Epics.** Not adopted: Epics keep resolving from their labels and
  the defaults.

## Consequences

- An Attempt can carry Cost for a call that did no implementation work; the
  routing line keeps it separate so Stats and the Ticket page can show it.
- A Workspace with the classifier on and no Model Options in its resolved list
  has nothing to pick from; the classifier abstains every time.
- The Harness backend spends a one-shot Harness Session per Attempt start; the
  TypeSafe and OpenAI-compatible backends need their own endpoint credentials.
- A switch of Harness between Attempts now happens without operator action,
  so cold-Session continuations become more frequent on classified Tickets.

## Open questions

- The classifier timeout and whether it is configurable.
- Whether a Model Option's Model is validated against its Harness's model
  catalog on save (ADR-0049 leaves Task Model ids unvalidated; Critics are
  validated).
- Where the TypeSafe and OpenAI-compatible backend credentials are stored
  (an ADR-0046 Secret is the obvious home, but it is not decided).

## Supersedes

None. Amends ADR-0049: the precedence list gains the Route Classifier between
the Routing Label and the Workspace default, and Native Tasks, which ADR-0049
leaves unrouted, are now classified.
