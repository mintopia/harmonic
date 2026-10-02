# Decision: Agent Messages travel over Harmonic's MCP server with A2A-shaped payloads

Status: proposed
Date: 2026-10-02

## Context

Epic Members run in parallel, often on different Harnesses, and cannot tell
each other about shared changes ("I changed the `Session` interface", "are you
touching `merge.ts`?"). Each discovers the other's work only at merge time.

The standard for agent-to-agent communication is A2A (Agent2Agent): Agent
Cards, `message/send`, Messages made of Parts. A2A assumes every agent is an
HTTP server with an A2A client. Claude, Codex, and Copilot are neither; they
speak ACP to Harmonic and MCP to tools. Harmonic already injects its own MCP
server into every Attempt with an Attempt Key that identifies the caller, and
already has a steer channel that delivers operator text to a live Agent
(mid-turn where the Harness supports `_session/steering`, otherwise at the next
turn boundary).

## Decision

**Transport: MCP, not an A2A broker.** Agents send and read Agent Messages
through tools on Harmonic's existing MCP server (`send_message`,
`read_messages`, `list_peers`). Harmonic does not expose per-Task A2A
endpoints or Agent Cards. Inside one Workspace a broker would only ever send
A2A to itself, since no Harness can originate A2A.

**Payload: A2A-shaped.** An Agent Message is stored with A2A Message
semantics (message id, role, Parts, reply reference) so a per-Task A2A
endpoint for external agents can be added later without remodelling. A2A's
own "Task" noun is not adopted; Harmonic's Task keeps its meaning.

**Address: a Task, or the sender's Epic.** Never a Session or Agent, which are
ephemeral. Addressing the Epic reaches every open sibling Member as one Agent
Message. Sending to a *draft*, *done*, or *cancelled* Task is refused.

**Delivery: the steer channel.** A live recipient receives the text over the
steer channel, framed as coming from the peer Task, never as operator
instruction. A recipient with no live Agent (between Attempts, *ready*,
*paused*, *escalated*) gets held messages at the start of its next Attempt.

**Semantics: one-way and asynchronous.** The sender never blocks on a reply; a
reply is another Agent Message referencing its parent, and a root plus its
replies form a **Thread**. A per-Attempt send cap (Setting Override) bounds
two agents answering each other indefinitely.

**Scope and gating.** Workspace-scoped. Only Task Attempts get the tools — not
Epic resolve agents, Conversations, or Critics. Off by default: a Setting
Override (Baseline → Global → Workspace); where off, the tools are not
registered on the Attempt's MCP session and no peer line is added to the
prompt. Held messages from a period when it was on remain visible.

**Visibility.** Every Agent Message appears on both participants' Task
timelines, and Threads are readable (not writable) by the operator. Agent
Messages raise no Notifications. They are persisted, included in the Task's
Archive/Export, and deleted with their Workspace; a Thread survives one
participant Task's deletion.

**Operator UI: an "Agent Messages" tab inside Activity.** Activity gains tabs,
"Running now" and "Agent Messages". The tab is based on the Conversations page
layout: a Thread list, a chat transcript, and a right-hand Agents drawer
listing each participant (Harness and model, lifecycle state, Attempt number,
sends-used meter, "Open Task →"). No composer and no steer control (ADR-0026);
steering a participant is done from its Task.

- *Transcript.* Slack-style: every message left-aligned, grouped by
  consecutive sender, quoted snippet on a reply, day and time separators. Each
  message shows the time once in its group header; no hover timestamps.
- *Receipts.* `✓` queued, `✓✓` delivered, `◷` held, rose `✕` refused, with the
  detail in a muted tail; an Epic-addressed message shows one receipt per
  recipient.
- *Sender identity.* A neutral Harness-glyph tile with a per-participant
  identity colour on ring and name, from a palette that avoids every state
  hue and meets AA in both themes. Only three such hues exist, so colours may
  repeat within a Thread; the glyph and Task number disambiguate.
- *Lifecycle labels.* The drawer uses the canonical lifecycle labels and
  colours; "between Attempts" is a muted sub-label of Working. The sends meter
  is neutral and text-first ("7/10"), rose only at the cap.
- *Global scope.* The tab follows "Running now": it aggregates every
  Workspace, adds a Workspace filter ahead of the Epic filter, and badges each
  Thread row with its Workspace when the filter is "All".
- *Feature off.* The tab is hidden for a Workspace where Agent Messages are
  off, and at Global scope hidden only when they are off in every Workspace.
  Turning the feature off hides that Workspace's Threads from the tab; they
  remain in Archive/Export.
- *Task timeline.* Each Agent Message is a Lifecycle row on both the sender's
  and the recipient's Task ("Agent Message sent to #412 · Claude" / "received
  from"), with the receipt state, a one-line preview, and "View Thread →".

## Consequences

- No new dependency or protocol surface; caller identity reuses Attempt Keys.
- Delivery inherits the steer channel's per-Harness behaviour: Codex and
  Copilot receive at turn boundaries, which can add a turn per message — the
  reason for the send cap.
- External A2A agents cannot reach a Task until a later ADR adds the endpoint.

## Supersedes

None.
