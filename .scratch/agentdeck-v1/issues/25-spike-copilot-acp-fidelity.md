# Spike: Copilot ACP fidelity

Status: done

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

- [x] A findings document exists covering all seven questions above with real captured payloads
- [x] Model pinning is classified: mechanism + actual-model verification, or not pinnable (collapsing the Copilot `models` list per Q7)
- [x] Usage availability is classified: ACP result, session-log fallback (with sessionId correlation shown), or unavailable
- [x] AI Units observability is classified: per-Run observable (source + shape recorded) or not observable
- [x] ACP `mcpServers` support is classified: works / unsupported
- [x] A clear go/adjust recommendation for issue 26

## Blocked by

- Issue 22 — not a hard dependency, but this spike's question list should
  absorb whatever issue 22's findings sharpen before starting. Requires
  Copilot credentials in the workspace (operator-provisioned).

## Comments

2026-07-14 (agent): Done. Findings in
`.scratch/agentdeck-v1/spike-findings-copilot-acp.md`; raw captures and the
probe under `spike/`. Classifications:

- **Entry point**: `copilot --acp` is real (no adapter package needed) —
  ACP protocol 1, ndjson on stdio, `agentInfo Copilot 1.0.69`.
- **Model pinning: not pinnable on the probed account.** `--model` and
  `COPILOT_MODEL` are ignored in `--acp` mode; `session/set_model` accepts
  anything (even garbage) and sets the *requested* model, but the service
  silently serves its own routing choice (`gpt-5.4` and
  `claude-sonnet-4.5` requests both served by `claude-haiku-4.5`). The
  non-ACP path reveals why: the account's selectable-model list is empty
  ("Model … is not available" for every id) — auto-only plan. Issue 26
  must collapse the Copilot models list to `auto` (Q7). Actual-model
  verification exists on two surfaces (session-log `assistant.message.model`,
  OTel `gen_ai.response.model`).
- **Usage: OTel file exporter** (`COPILOT_OTEL_FILE_EXPORTER_PATH`,
  per-run file). The ACP prompt result is bare (`{stopReason}` only — no
  usage, no `_meta`), and the native session log
  (`~/.copilot/session-state/<acp-sessionId>/events.jsonl`, correlation
  verbatim) has no token counts for ACP sessions (`session.shutdown`
  never fires). OTel `chat` spans carry per-call input/output/reasoning
  tokens + response model, with an omit-when-zero cache split
  (`cache_read`/`cache_creation`; `input_tokens` is total input).
- **AI Units: per-Run observable** — `github.copilot.nano_aiu` (and the
  legacy multiplier `github.copilot.cost`) per chat span; ships as the
  optional Usage field per decision Q4.
- **MCP**: `session/new` `mcpServers` HTTP + bearer works end to end;
  every request carried the Run Key header.
- **Auth**: keychain login honored headlessly; empty `COPILOT_HOME` does
  NOT detach it; an invalid `COPILOT_GITHUB_TOKEN` silently falls back to
  the stored login. Truly unauthenticated `session/new` fails with
  JSON-RPC `-32000 "Authentication required"` — same legible shape as
  Codex, zero adapter work.
- **Quirks**: CLI auto-updates itself on spawn (pin with
  `COPILOT_AUTO_UPDATE=false`); operator plugins/skills leak into ACP
  sessions; no `agent_thought_chunk`, no `usage_update`; permission
  options are `allow_once`/`allow_always`/`reject_once`; built-in
  github-mcp-server spawns per session (`--disable-builtin-mcps`).

**Go for issue 26** as an auto-model harness; the one seam change is
additive (`spawnEnv` needs the run workdir so it can point
`COPILOT_OTEL_FILE_EXPORTER_PATH` at a per-run file; the Usage Collector
derives the same path from its existing `cwd` input).
