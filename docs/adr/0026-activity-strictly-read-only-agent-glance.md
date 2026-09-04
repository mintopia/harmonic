# Decision: Activity is a strictly read-only Agent glance; operator actions live on the Task page; permission needs are raised app-wide

Status: accepted
Date: 2026-09-04

Relates to ADR-0010 (the Activity/Operations split).

## Context

CONTEXT.md defines **Activity** as the surface that answers *"what are the Agents
doing"* — per-Agent Usage, context fill, tools, and the Process Tree. The shipped
build drifted from that in two ways:

- It made the **streaming Subagent transcript** a first-class element of the
  page. That transcript already lives on the Task page; on Activity it buried the
  fleet-wide signal (which Agent is hot, what is it spending) under one Agent's
  event stream.
- It grew into a second **action surface** — inline permission Grant/Deny,
  escalation Resolve, and per-process Stop. The same actions already have a home
  on the Task/Conversation page, so "answer a permission" and "stop an Attempt"
  now lived in two places, and Activity carried state and affordances a glance
  surface should not.

Separately, a permission that needs the operator was only discoverable by being
*on the surface that happened to show it*. If the operator is looking at the
Board, a permission pending on an Attempt is invisible until they navigate.

## Decision

### 1. Activity is strictly read-only — a whole-fleet Agent glance

Activity is the instance-wide, read-only view of every in-flight Agent (the root
Process Tree node driving an Attempt or Conversation) and its Subagents,
foregrounding each node's **context fill, tokens, Cost, model, hierarchy, and
last tool**. Layout is **Fleet Lanes**: each Agent is a horizontal lane whose
hero element is a wide live context meter (context fill is the primary live
signal), with Subagents as indented sub-lanes (indent is the only hierarchy
signal). The **sole interaction is a deep-link** to the Agent's Task or
Conversation page. Activity holds no state and exposes no action endpoints.

### 2. Operator actions live on the Task/Conversation page — one home each

Stop/Kill, permission answers (Grant/Deny), and escalation resolve live *only* on
the Agent's Task or Conversation page. No action is duplicated onto Activity.
The streaming Subagent transcript is likewise removed from Activity — it stays on
the Task page.

### 3. A permission that needs the operator is raised app-wide

A pending permission is surfaced by a persistent alert at the **top of every
page** (an app-shell concern), not by whichever surface happens to render it. No
individual surface has to carry a permission affordance to make "needs you"
discoverable — so Activity dropping the inline Grant/Deny costs no discoverability.

### 4. Server carries a per-node last tool

The Activity snapshot gains a per-Process-Tree-node `lastTool` (the most-recent
tool name), computed in the usage-sampler where the tree is built, degrading to
`null` where a harness cannot supply it. This replaces the prose "what it's doing
now" line on the Activity surface.

## Consequences

- Activity loses its action wiring (permission/resolve/stop) and its
  transcript/drill-in; it becomes a pure snapshot+firehose glance that deep-links
  out. Simpler, and back in line with CONTEXT.md's Activity definition.
- The **global permission alert** is new app-shell behaviour (it needs
  pending-permission state available app-wide, not just on Activity) — tracked as
  its own ticket. Until it ships, a permission is answered by deep-linking to the
  Task page: a click-count regression, never a loss of capability, and the review
  gate stays sacred.
- `lastTool` is a small addition to the server snapshot, DTO, and the `ProcessNode`
  type; the UI renders a single tool per node, no trail.
- Tradeoff accepted: unblocking an Agent is one deep-link from Activity rather
  than inline. Chosen because a single canonical home per action beats a
  duplicated affordance, and the app-wide alert makes pending permissions
  unmissable regardless of which surface the operator is on.

## Alternatives considered

- **Keep inline actions on Activity.** Rejected: two homes for the same action,
  and it kept Activity a busy action surface instead of a glance.
- **A permission banner only on the relevant surface.** Rejected: less
  discoverable than app-wide; the whole point is that "needs you" should reach the
  operator wherever they are.
- **Tables / cards / process-tree layouts.** Rejected in favour of Fleet Lanes:
  context fill is the signal that most drives operator attention, so the meter
  earns being the row. (The process-tree view remains a candidate future per-Agent
  drill-in, not the whole-fleet view.)
