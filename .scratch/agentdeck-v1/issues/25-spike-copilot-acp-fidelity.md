# Spike: Copilot ACP fidelity

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

A timeboxed spike, not production code — the Copilot twin of issues 01 and
22, expected to be the riskier of the two new harnesses (its ACP mode and
log format are the least documented). Drive `copilot --acp` (verify that is
in fact the entry point) with a real prompt and record what actually comes
back.

Answer the same question set as issue 22:

- **Entry point**: does `copilot --acp` speak ACP on stdio as configured,
  and which protocol revision?
- **Model pinning**: mechanism (`--model`, env, ACP-level) plus
  verification of the model *actually used* — settings we show must be
  real (Q7).
- **Usage**: `usage` on the `session/prompt` result? Native session-log
  location and format, and whether the ACP `sessionId` correlates to a log
  file. Per-model token breakdown must be derivable for the Usage
  Collector.
- **MCP registration**: does `session/new` honor `mcpServers` with an HTTP
  server + bearer header? Env-var fallback if not.
- **Auth**: which GitHub credentials work headlessly (CLI login state on
  disk, token env vars), where auth state lives, and what an
  unauthenticated spawn looks like so the failure reason can be legible.
- **Quirks**: permission-request option shapes, `session/update` event
  fidelity, nested-session/sandbox issues.

Plus one Copilot-specific question (decision Q4 of the planning session,
2026-07-14):

- **AI Units observability**: is per-Run AI Unit consumption observable
  anywhere — session log, CLI output, ACP metadata, GitHub API? If yes,
  record where and in what shape; it becomes an optional Usage field shown
  as actual spend alongside Cost (see CONTEXT.md "AI Unit"), never a Cost
  input. If no, nothing ships.

The deliverable is a findings note committed under the feature directory
with raw captured payloads, plus a go/adjust recommendation for the Copilot
support slice (issue 26).

## Acceptance criteria

- [ ] A findings document exists covering all seven questions above with real captured payloads
- [ ] Model pinning is classified: mechanism + actual-model verification, or not pinnable (collapsing the Copilot `models` list per Q7)
- [ ] Usage availability is classified: ACP result, session-log fallback (with sessionId correlation shown), or unavailable
- [ ] AI Units observability is classified: per-Run observable (source + shape recorded) or not observable
- [ ] ACP `mcpServers` support is classified: works / unsupported
- [ ] A clear go/adjust recommendation for issue 26

## Blocked by

- Issue 22 — not a hard dependency, but this spike's question list should
  absorb whatever issue 22's findings sharpen before starting. Requires
  Copilot credentials in the workspace (operator-provisioned).

## Comments
