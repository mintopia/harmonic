# Decision: Conversations and interactive permissions

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

## Conversations are a first-class sibling to Task

A **Conversation** is an interactive, multi-turn exchange the operator drives
with a harness in a Working Directory over ACP. It is its own concept beside
Task — its own `conversations` / `conversation_events` tables, its own driver,
its own `active → ended` lifecycle — not a Task variant, because it
participates in none of Task's defining machinery: never queued, never picked
by the Auto-Runner, no verification gate, no isolation mode (worktrees exist
to produce a mergeable branch; a Conversation has nothing to merge).
Conversations are direct-mode only.

The genuinely shared plumbing is reused by extraction, not by table-sharing:
the ACP driving loop, per-turn Usage collection, and the event renderer
(Conversation event payloads are byte-identical in shape to execution events,
so rendering is shared by shape, not table).

`ConversationDriver.interrupt` cancels the in-flight turn (`session/cancel`)
and re-prompts — the deliberate inverse of task steering (ADR-0005), because a
chat is interactive and a stale half-answer is worthless.

## Interactive, human-in-the-loop permissions

In a Conversation the driver holds the harness's ACP
`session/request_permission` request **open** and prompts the operator in the
UI, resolving it only when they pick an option — the agent's turn genuinely
blocks on the human. This is the deliberate inverse of unattended execution,
which auto-picks so autonomous work never waits. Remembering has three tiers:

- **Allow once**.
- **Allow for this conversation** — native ACP `allow_always`, dies with the
  Conversation.
- **Permission Rule** — opt-in persistent auto-approval keyed on tool
  **kind** + Working Directory, surfaced and revocable in Settings. Rules are
  a security escalation, so they are never the default click, always
  operator-visible, always revocable; remembering you cannot audit or undo is
  not offered.

The round-trip spans transports: the request broadcasts over the firehose WS
and is answered via `POST /conversations/:id/permissions/:reqId`; the driver
keeps a pending-request registry keyed by request id.

## Dropped at the reset

The pre-reset proposal that **autonomous** executions hold permission
requests for operator approval (old ADR-0032, status `proposed`, never built)
is **dropped by owner decision**, not carried as intent: unattended
executions keep their auto-granting posture, and the escalation surface
(ADR-0002) remains the operator's control point. A future need is a fresh
decision.

## Consequences

- Two execution paths (driver vs runner) exist by design; shared ACP/Usage
  logic must be extracted rather than duplicated as it grows.
- Chat defaults (harness/model) are their own overridable Workspace pair,
  locked at Conversation creation (ADR-0009).

## Absorbed at the reset

Pre-reset 0006 and 0007 in full; 0032 dropped. See README.md for the mapping.
