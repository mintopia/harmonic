export function buildSpecDescription(pkg: { description: string }): string {
  return `${pkg.description}

## MCP

\`POST /mcp\` is a stateless streamable-HTTP MCP server (not a REST
endpoint, so it has no entry in this spec's paths). It authenticates the
same way as the REST API — a bearer token, either an operator API key or
the Attempt Key Harmonic injects into a spawned harness — and exposes the
agent task surface as MCP tools (task CRUD, dependencies, queue/cancel,
attempts and events). Accept/Reject are human-only and are never exposed as
MCP tools — a verifier's pass is the accept (#140, ADR-0021). An attempt-scoped
Attempt Key may call \`/mcp\` regardless of the REST restrictions noted per
endpoint below. \`force_integrate_epic\` is an operator-only tool, the same
footing as Accept/Reject: an Attempt Key can call \`/mcp\` but gets a \`forbidden\`
error from it specifically — only an operator API key (\`scope: 'full'\`) or
an authenticated session may call it.

## WebSocket

\`GET /api/ws\` is a single firehose WebSocket (also outside this spec's
paths): every attempt event, attempt state change, task state change/removal, and
Conversation event/change is broadcast to every connected client as JSON
messages of the form \`{ type: 'attempt_event' | 'attempt_changed' | 'attempt_usage' |
'task_changed' | 'task_removed' | 'conversation_event' | 'conversation_changed' |
'permission_request' | 'scheduled-jobs' | 'operations', ... }\`, using the same Task/Attempt/Conversation/Scheduled Job/Operation shapes
served over REST. \`attempt_usage\` is a live-usage snapshot for a running Attempt
(tokens, context fill, derived Cost, current-activity line, and Process
Tree), pushed about once a second while the Attempt tails its native log.
\`task_removed\` (issue #162) announces a hard-deleted Task's id (\`{ type:
'task_removed', id }\`) — the row is gone, not another state change.
\`scheduled-jobs\` announces the full Scheduled Job registry snapshot, matching
\`GET /api/scheduled-jobs\`.
\`operations\` announces an Operation lifecycle event, matching the operation shape
served by \`GET /api/operations\`.
\`permission_request\` announces a Harness blocked on an
operator permission decision in a Conversation (ADR-0007), answered via
\`POST /conversations/:id/permissions/:reqId\`. Authenticate by offering the
session token or an API key as the sole WebSocket subprotocol
(\`new WebSocket(url, [token])\`) — never as a query parameter, which leaks
into logs and browser history. A browser client authenticated by session
cookie needs no subprotocol. A \`read\`-scoped key gets a filtered firehose — only
\`task_changed\`, \`task_removed\`, \`attempt_changed\`, \`attempt_event\`, \`attempt_usage\`, and
\`operations\` — with the Conversation and permission traffic dropped.

## Read scope

A \`read\`-scoped API key (created via \`POST /api/keys\` with
\`{ "scope": "read" }\`) is a viz-client credential: it may \`GET\` tasks,
attempts, maps, Operations (\`/api/operations\`), and the instance-wide Activity snapshot (\`/api/activity\`,
filtered to Attempts only for a read key), and open the WebSocket (filtered as
above). Every mutation and the whole operator surface (keys, config,
channels, Conversations) is blocked. There is no \`map_changed\` event — a
client re-fetches \`/maps\` on reconnect or when it sees a \`mapRef\` it has
not resolved yet.`;
}
