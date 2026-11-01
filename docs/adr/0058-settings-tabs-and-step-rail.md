# Decision: Settings tabs are regrouped, and each tab with steps uses a step rail

Status: accepted; amends ADR-0009's tabbed-engine clause only
Date: 2026-11-01

The Settings tabs become General · Running Tickets · Prompts · Integrations ·
Archive & Export. Security folds into General as the Access step. Each tab
with steps shows a left step rail, and the current step, selected by the
`step` query parameter, switches the main content. A resolution strip lists the
rules Harmonic checks in order. Issue #955. Amends ADR-0009's "One
schema-driven, tabbed engine" clause (its tab list and layout only); the
schema, inheritance markers, and single save bar stand.

## Context

ADR-0009 renders Settings as one tabbed engine with six tabs: General,
Execution, Prompts, Integrations, Security and Archive & Export. Each tab is a long
form, so an operator who wants one setting scrolls past the others. The tab
names also do not match the order in which Harmonic resolves a Ticket: the
workflow, the agent, the place it runs, and the limits. Security is a tab of its
own, though it is part of access and identity. Issue #955 asks for the Settings
UI to follow the order of the decisions and to show each decision's current
value.

## Decision

### Tabs

- **Five tabs:** General · Running Tickets · Prompts · Integrations · Archive
  & Export. This replaces General · Execution · Prompts · Integrations ·
  Security · Archive & Export.
- **Running Tickets is the label only.** The tab id stays `execution` in code
  and in URLs (`?tab=execution`). Its steps are Workflow, Agent, Where and
  Limits.
- **Security folds into General.** Its controls move to the Access step.
- **Step sets:** General has Identity, Access, Chats and Files. Prompts has
  Find, Edit and Check impact. Integrations has Code, Work, Agents and Updates.
  Archive & Export has Keep, Export, Redact and Deliver.

### Step rail

- **A tab with steps shows a left step rail.** Each row is numbered and carries
  a title and a one-line summary.
- **Selecting a step switches the main content.** It never scrolls the page to
  another section. Back and Next buttons sit at the foot of the content.
- **Step states.** The current step is teal. Earlier steps are green and show
  their chosen value. Later steps are outlined.
- **Location is in the URL.** The tab and step live in the query string
  (`?tab=execution&step=where`), carried on the route so a reload lands on the
  same step.
- **Layout.** On desktop (md and up) the rail is sticky and stays in view while
  a long step scrolls. At phone width the rail stacks above the content.
- **Hidden steps.** A step with no content for a surface is hidden. A Workspace
  does not show global-only steps.

### Resolution strip

- **Used where Harmonic resolves something in order.** The first use is
  Running Tickets › Workflow. The strip lists the rules in the order Harmonic
  checks them, each as a card.
- **The always-matching rule** has a teal (2px accent) border.
- **Rules set elsewhere** have a dashed border and are not links.

### Unchanged

- The ADR-0022 inheritance markers (muted inherited value, modified marker,
  per-field revert) and the single buffered save bar.
- ADR-0009's schema-driven rendering, which still builds both the global and
  the Workspace surface.
- Intro and description text fills its column. It has no reading-measure
  `max-width` cap.

## Consequences

- ADR-0009's tab list no longer describes the UI. ADR-0009's clause is amended
  here; its schema and inheritance rules are not.
- The Settings renderer needs step metadata per tab, a rail component, a
  resolution-strip component, and URL state for `step`.
- The Security tab's controls move under General, Access.
- A step is a UI step in Settings. It is not a workflow Step (ADR-0053).
- The mockups in `docs/mockups/settings-flow/` define the pattern. Built
  screens must match them.

## Supersedes

None. Amends ADR-0009's "One schema-driven, tabbed engine" clause (tab list
and layout). Other ADR-0009 clauses are unchanged.
