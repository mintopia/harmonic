# Design: Agent Messages

Backing decisions: ADR-0045 (transport, payload, addressing, delivery,
gating, operator UI). Nothing here overrides it.

## Test seams

Highest existing seams, preferred over new ones:

1. **MCP endpoint through the real server with Attempt Keys** (prior art:
   the MCP test that drives tools with a client bound to a token). Covers
   gating, addressing, refusal, send cap, payload shape, Threads, and
   persistence. This is the primary seam; most acceptance criteria are proven
   here.
2. **Run control with the stub Harness** (prior art: the steer/resume
   run-control test and the stub Harness). Covers live delivery mid-turn
   versus next turn, held messages injected at the next Attempt, and receipt
   transitions, including across a restart.
3. **Web model tests** for the pure models (activity, lifecycle timeline,
   conversation list/transcript). Covers filters, Global aggregation, hiding,
   row kinds. Screenshot comparison against the approved v5 mockup covers
   layout.
4. **Task export test** for the bundle file and README row.

No new seam is introduced. The only new injection point is the caller
identity handed to the MCP server builder, which the existing MCP test
exercises directly.

## Caller identity on the MCP server

The `/mcp` handler resolves the bearer Attempt Key to its Attempt, Task,
Workspace, and key scope before building the server, and passes that caller
into the builder. Tool registration becomes a function of the caller: the
three tools register only for an attempt-scoped key on a Task Attempt in an
enabled Workspace. This is a prefactor that every other slice depends on.

## Storage

One table of Agent Messages with the A2A-shaped columns (message id, role,
Parts as JSON, reply reference), sender Task and Attempt, Workspace, and a
recipients JSON array of `{ taskId, receipt, deliveredAt?, reason? }`. The
Thread id is the root message id, denormalised so Thread queries need no
recursion. The per-Attempt send count is derived by counting rows for the
Attempt, not stored. Workspace deletion cascades; Task deletion leaves rows
and the UI marks the missing side as deleted.

## Delivery

Sending runs the existing steer path for each recipient with a live run,
using a peer frame ("Message from Task #412 (Claude)") rather than the
operator frame, and records the resulting mode (mid-turn or next turn) on the
receipt. Recipients without a live run get receipt *held*. Attempt start reads
held messages for the Task from the database (not the in-memory operator
seed) and appends them under a "Messages from peers" heading after any
operator message, then marks them delivered.

## Settings

Two registry entries, following the Auto-Runner toggle end to end: registry,
config schema, baseline, nullable Workspace column, Workspace schema and
store, Settings UI schema, and the Workspace Settings save payload. The
Workspace API response gains the effective boolean so the web can gate the
tab; the Global activity response gains "enabled anywhere".

## Web

Activity gets the existing Tabs component with "Running now" and "Agent
Messages". The new view reuses the Conversations page skeleton (list, pane,
drawer) and transcript segmentation with a new message type, omitting the
Composer. Identity colours come from a three-hue palette assigned per
participant in Thread order and allowed to repeat. The timeline gains an
`agent-message` row kind in the DTO and web types, a model case, and a
renderer.

## Open questions

None. Send-cap default 10 confirmed 2026-10-02.
