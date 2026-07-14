# MCP server & scoped key injection

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Agents scheduling their own follow-up work. An MCP server (streamable HTTP
on localhost, same authorization model as the REST API) exposes tools to
create, list, get, and update Tasks, add/remove Dependencies, queue,
cancel, and read Task status, Runs, and Run Events — so an agent can build
autonomous pipelines and react to the outcomes of prior work.

When AgentDeck starts a Run, it mints a scoped API Key for that Run and
injects the key plus the MCP endpoint into the spawned Harness's
environment, so agents reach MCP with zero manual setup. Revoking follows
the Run's lifetime.

Accept/Reject tools exist only behind the agent-review config flag
(default off): the merge gate stays human by default, and full autonomy —
agents landing branches unattended (ADR-0002) — is a deliberate opt-in.

## Acceptance criteria

- [x] An MCP client with a valid API Key can create, list, get, update, queue, and cancel Tasks and manage Dependencies
- [x] Task status, Runs, and Run Events are readable over MCP
- [x] Every spawned Harness receives a per-Run scoped API Key and the MCP endpoint in its environment (asserted via the stub harness)
- [x] With the agent-review flag off (default), Accept/Reject tools are absent from the MCP tool list; with it on, they work
- [x] Unauthenticated or revoked-key MCP requests are rejected
- [x] Tests cover an end-to-end loop: a stub-harness Run uses its injected key to create a dependent follow-up Task

## Blocked by

- `07-dependencies.md`
- `09-auth-and-api-keys.md`

## Comments

**2026-07-14 (agent):** Done. Stateless streamable-HTTP MCP endpoint at
`/mcp` (fresh McpServer per request via src/mcp/server.ts, so the tool
list always reflects config), gated by the same bearer-key hook as REST.
Tools: create/list/get/update task, queue (promote or requeue with
feedback), cancel (with dependents), add/remove dependency, get_runs,
get_run_events; accept_task/reject_task registered only when the
`agentReview` config flag is on (default off). The runner mints a
scope='run' key per run and injects AGENTDECK_API_KEY + AGENTDECK_MCP_URL
into the harness env, revoking it when the run finishes. Tests cover the
whole surface, including the end-to-end loop: a stub-harness run uses its
injected key to create a follow-up task depending on itself, which
unblocks when the parent is accepted.
