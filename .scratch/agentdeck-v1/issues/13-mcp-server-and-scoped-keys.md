# MCP server & scoped key injection

Status: ready-for-agent

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

- [ ] An MCP client with a valid API Key can create, list, get, update, queue, and cancel Tasks and manage Dependencies
- [ ] Task status, Runs, and Run Events are readable over MCP
- [ ] Every spawned Harness receives a per-Run scoped API Key and the MCP endpoint in its environment (asserted via the stub harness)
- [ ] With the agent-review flag off (default), Accept/Reject tools are absent from the MCP tool list; with it on, they work
- [ ] Unauthenticated or revoked-key MCP requests are rejected
- [ ] Tests cover an end-to-end loop: a stub-harness Run uses its injected key to create a dependent follow-up Task

## Blocked by

- `07-dependencies.md`
- `09-auth-and-api-keys.md`
