# Decision: afk Runs use the held-request permission model with remembered Rules

Status: proposed
Date: 2026-08-21

## Context

Two permission models exist in the codebase today, and they disagree.

- Conversations (ADR-0007) hold each harness `session/request_permission`
  open and prompt the operator, resolving only when they pick an option. An
  opt-in Permission Rule (tool kind plus Working Directory) auto-approves future
  matching requests silently. The `PermissionRuleStore` and the
  `ConversationDriver.decidePermission` / `answerPermission` /
  `cancelPendingPermissions` machinery already implement this.

- afk Runs do not. The Runner puts Claude into `auto` mode (safe tools
  auto-approved harness-side) and, on any request that reaches it, Escalates:
  declines, cancels the turn, hands the Task back. Codex advertises no `auto`
  mode; it now runs `approval_policy: on-request` and likewise Escalates each
  request. In both cases a single privileged action that needs approval ends the
  unattended Run instead of pausing it, and nothing is remembered. The next
  attempt hits the same wall.

The desired behaviour for an afk Run is the same one Conversations already have:
ask, but keep the session alive; let the operator approve; remember the decision
so it does not ask again. This ADR unifies the two models: afk Runs adopt the
ADR-0007 held-request plus Permission-Rule approach.

One wrinkle is unique to Runs. A Run may execute in an isolated git worktree,
so its live `workingDir` is an ephemeral path that will not exist next run. A Rule
keyed on that path would never match again, and would not be shared with
Conversations working in the same repo. Runs must key Rules on the stable
workspace root (the repo the Task belongs to), not the worktree.

## Decision

1. afk Runs hold, they do not Escalate on a permission request. The Runner
   gains the ADR-0007 flow: a `session/request_permission` from an afk Run whose
   tool kind plus workspace root matches a Permission Rule is auto-approved silently
   (recorded, rule-flagged, never a silent grant); otherwise the request is
   held open (the ACP promise stays pending, so the harness turn, and the
   Run, stay alive) and surfaced to the operator. This replaces the
   escalate-decline-cancel path for both Claude and Codex. Claude keeps `auto`
   mode, so only genuinely risky requests reach the hold; Codex asks per action
   (`on-request`), and Rules collapse the repeats.

2. The operator answers out of band, and may remember. An operator-only
   endpoint resolves a held request with the chosen ACP option; with `remember`
   it persists a Permission Rule (tool kind plus workspace root) via the existing
   `PermissionRuleStore`, exactly as Conversations do. Run-scoped Run Keys cannot
   answer permission requests.

3. Run Rules key on the workspace root, not the worktree. A Rule created from
   a Run (or matched for one) uses the Task's stable workspace directory, so a
   remembered grant persists across Runs and is shared with Conversations in the
   same repo. Conversation Rules are unchanged (they already key on the
   Conversation's Working Directory, which is the repo).

4. A held Run is parked, visible, and bounded. While a request is held the Run
   stays `running` but is surfaced as awaiting approval (a distinct lifecycle
   signal, not `awaiting-review`) on the board and ticket, and the operator is
   notified through the existing notification delivery. Because an unattended Run
   holding a Work Context slot indefinitely would starve other work, a
   configurable approval SLA bounds the wait: on expiry the Run Escalates the
   held request (the pre-existing hand-back), so a forgotten approval degrades to
   today's behaviour rather than a stuck slot. Default SLA parallels the review
   SLA (issue #114).

5. Held requests never leak. On Run cancel, crash, or process shutdown, held
   requests resolve as cancelled (mirroring `cancelPendingPermissions`). A held
   request does not exist across a Harmonic restart (the harness process is
   gone), so the boot recovery sweep treats an interrupted held Run like any other
   interrupted Run.

6. The tool-timeout watchdog pauses while a request is held. A held request
   blocks the turn by design; the tool-timeout guardrail (issue #131) and turn
   timers must not count the approval wait, or they would fire and Escalate before
   the operator can answer. Only the approval SLA (point 4) bounds the hold.

## Consequences

- An afk Run that needs approval pauses and asks instead of dying; once the
  operator remembers a decision, that class of request never interrupts a Run in
  that repo again, since the Rule is shared with Conversations. This is the payoff.
- Claude's afk behaviour changes: a risky-tool request now holds for approval
  rather than Escalating immediately. This is intended: the Escalate-on-risky
  path was a stopgap, not a decision.
- Codex afk becomes usable unattended without granting blanket full access: it
  asks (`on-request`), the operator approves-and-remembers, and YOLO stays an
  explicit opt-in through the harness command-line options.
- The operator gains a new responsibility surface (pending approvals) and a new
  way an afk Run can stall (unanswered approval), bounded by the SLA. The SLA
  default must be chosen so a genuinely unattended instance still makes progress
  or degrades cleanly.
- Rule granularity stays coarse (tool kind plus directory), inherited from ADR-0007.
  A finer key (per-command, per-path) is out of scope; if the coarse grant proves
  too broad for unattended use, that is a follow-up decision, not this one.
- Reusing `PermissionRuleStore` and the `decidePermission` shape keeps one
  permission model in the codebase instead of two divergent ones.

## Supersedes

None. Extends ADR-0007 (interactive permissions for Conversations) to afk Runs,
and reuses its `PermissionRuleStore`. Retires the afk Escalate-on-request stopgap
for both Claude and Codex.
