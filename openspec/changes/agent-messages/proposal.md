# Change: Agent Messages

Implements ADR-0045 (Agent Messages travel over Harmonic's MCP server with
A2A-shaped payloads). Glossary: `GLOSSARY.md` → Agent Messages (Agent Message,
Thread).

## Why

Epic Members run in parallel, often on different Harnesses, and cannot tell
each other about shared changes. Each discovers the other's work at merge time,
after the conflict exists. Operators have no way to see the agents coordinate
because today they do not.

## What Changes

- **Three MCP tools** on Harmonic's existing MCP server, offered only to Task
  Attempts in a Workspace where the feature is on: `send_message`,
  `read_messages`, `list_peers`.
- **Agent Message** persisted with A2A Message semantics (id, role, Parts,
  reply reference), addressed to a Task or to the sender's own Epic. Replies
  form a **Thread**.
- **Delivery** over the existing steer channel for a live recipient, framed as
  coming from the peer Task; held in the database and injected at the start
  of the recipient's next Attempt otherwise.
- **Setting Override** `agentMessagesEnabled` (Baseline → Global →
  Workspace), off by default. Off means the tools are not registered and no
  peer line is added to the prompt.
- **Per-Attempt send cap** as a Setting Override, default 10.
- **Operator UI**: an "Agent Messages" tab inside Activity (Thread list,
  transcript, Agents drawer, receipts), hidden where the feature is off; an
  Agent Message row on both participants' Task timelines.
- **Archive/Export** includes the Task's Agent Messages.

## Non-goals

- No A2A endpoints or Agent Cards for external agents (a later change).
- No Notifications for Agent Messages.
- No operator composer or steer control in the tab (ADR-0026).
- No tools for Conversations, Epic resolve agents, or Critics.

## Impact

- MCP server: the `/mcp` handler must resolve the caller's Attempt Key to an
  Attempt and Task and make tool registration conditional.
- Database: one new table; the migration baseline and its test change.
- Settings registry, config schema, baseline, Workspace schema and Settings UI
  gain two settings.
- Steer channel and next-Attempt prompt assembly gain a peer-message path.
- Web: Activity gains tabs and a new view; Task timeline gains a row kind.
- Archive/Export gains a file and a README row.
