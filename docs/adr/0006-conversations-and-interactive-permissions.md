# Decision: Conversations and interactive permissions

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).
Amended 2026-09-10: adds an opt-in Automatic (full-auto) permission mode — see "Automatic mode" below.

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

## Automatic mode: opt-in full-auto approval (amendment 2026-09-10)

The human-in-the-loop default above is not the only posture a Conversation may
take. A Conversation can be set to **Automatic**, an opt-in mode in which the
driver approves every `session/request_permission` with no prompt — the agent
never pauses. This reuses the full-access path unattended Attempts already use:
where the harness exposes a native full-access session mode (Codex
`agent-full-access`), the driver calls `setMode` after handshake; otherwise
`decidePermission` short-circuits to the request's allow option instead of
holding it open for the operator.

Automatic approves **everything, unfenced** — edits, commands, fetches,
anywhere. The safety argument is containment, not restraint: a Conversation runs
in an isolated Workspace, so blanket approval stays inside that sandbox and is
the operator's informed choice. It is deliberately **not** gated to a Working
Directory the way a Permission Rule is.

Constraints that keep it consistent with the escalation posture above:

- **Default is Ask each turn.** Automatic is never the default, never implicit.
- **Always operator-visible** — an active Automatic mode is surfaced in the
  Conversation header, never buried.
- **Instantly revocable** — per-Conversation state, settable at creation and
  toggleable live; switching back restores the hold-open flow for the next
  request.

This changes nothing about unattended Attempts (ADR-0002 stays their control
point) and does not touch Permission Rules, which remain per-kind, per-directory
and persistent.

## Absorbed at the reset

Pre-reset 0006 and 0007 in full; 0032 dropped. See README.md for the mapping.
