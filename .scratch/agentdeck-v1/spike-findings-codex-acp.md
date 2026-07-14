# Spike findings: Codex ACP fidelity

Status: done
Date: 2026-07-14
Probe: `.scratch/agentdeck-v1/spike/codex-probe.mjs` + `spike/mcp-echo-server.mjs`
(raw captures in `spike/capture-codex-*.jsonl`)

## Headline

**Recommendation: go — but the entry point in `defaultConfig()` is wrong.**

`codex acp` is **not a subcommand** of the Codex CLI (probed at 0.142.5): the
CLI treats `acp` as an interactive prompt and dies with *"Error: stdin is not
a terminal"*. The real ACP entry point is the adapter package
**`@agentclientprotocol/codex-acp`** (probed at 1.1.2) — the same canonical
org as the Claude adapter; Zed's `@zed-industries/codex-acp` is deprecated in
its favor. It is a bridge: it spawns `codex app-server` from its **own
bundled `@openai/codex` dependency** (0.144.4 observed — the operator's
installed CLI is irrelevant unless `CODEX_PATH` points at it) and translates
ACP ↔ app-server. The Codex harness config must spawn
`npx --yes @agentclientprotocol/codex-acp`.

Everything below was captured against that adapter with a real ChatGPT-plan
login. Fidelity is high: model pinning, per-model usage, HTTP MCP with
bearer headers, and rich session updates all work.

## Q1: Entry point and protocol revision

- `initialize {protocolVersion: 1}` → accepted and echoed
  (`"protocolVersion":1`), with
  `agentInfo {name: "@agentclientprotocol/codex-acp", title: "Codex", version: "1.1.2"}`.
- Capabilities: `promptCapabilities {embeddedContext, image}`,
  `sessionCapabilities {resume, list, close, delete, additionalDirectories}`,
  `loadSession: true`, `mcpCapabilities {acp: false, http: true, sse: false}`.
- ndjson JSON-RPC on stdio; handshake identical to Claude's:
  `initialize` → `session/new {cwd, mcpServers}` → `session/prompt` →
  `{stopReason: "end_turn", usage, _meta}`. Process stays alive after the
  turn and must be killed by the client.

## Q2: Model pinning

**Classification: pinnable, with actual-model verification on three
independent surfaces.** (Per Q7, the `models` list can be *real*.)

Two working mechanisms (captures 2 and 3):

1. **Spawn-time env — recommended.** `CODEX_CONFIG` is a JSON object merged
   into the Codex session config:
   `CODEX_CONFIG={"model":"gpt-5.4-mini","model_reasoning_effort":"low"}`.
   The subsequent `session/new` result comes back with
   `models.currentModelId: "gpt-5.4-mini[low]"` — the flag being honored is
   directly observable. This fits `HarnessAdapter.spawnEnv()` exactly.
2. **ACP-level.** `session/set_model {sessionId, modelId: "gpt-5.4-mini[low]"}`
   → `{}` (success). ModelId grammar is `<model>[<effort>]`.

Actual-model verification (not just flag acceptance):

- The `session/prompt` **result** attributes usage per model:
  `_meta.quota.model_usage[0].model === "gpt-5.4-mini"` (captures 2, 3).
- The native rollout log's `turn_context` entry records
  `model: "gpt-5.4-mini", effort: "low"` (capture 2's session verified).

`session/new` also returns the **live model list** —
`models.availableModels` (30 entries at probe time: gpt-5.6-sol/terra/luna,
gpt-5.5, gpt-5.4, gpt-5.4-mini, each × effort levels, with descriptions) and
`configOptions` (mode / model / reasoning_effort / fast-mode selects).
The `defaultConfig()` guesses (`gpt-5.2-codex`, `gpt-5.2-codex-mini`) no
longer exist. Issue 24 should seed the config `models` list from verified
current ids — or better, refresh it from `session/new`'s `availableModels`.

## Q3: Usage

**Classification: ACP result — no session-log parsing needed.** Better than
Claude, where the per-model split only lives in the log.

The `session/prompt` result carries both aggregate and per-model usage
(capture 1):

```json
{"stopReason":"end_turn",
 "usage":{"totalTokens":16178,"inputTokens":6189,"cachedReadTokens":9984,
          "outputTokens":5,"thoughtTokens":0},
 "_meta":{"quota":{
   "token_count":{"totalTokens":16178,"inputTokens":6189,
                  "cachedInputTokens":9984,"outputTokens":5,
                  "reasoningOutputTokens":0},
   "model_usage":[{"model":"gpt-5.6-sol",
     "token_count":{"totalTokens":16178,"inputTokens":6189,
       "cachedInputTokens":9984,"outputTokens":5,
       "reasoningOutputTokens":0}}]}}}
```

Mapping for the Usage Collector: `cachedInputTokens` → cacheReadTokens;
there is **no cache-write figure** (report 0); `reasoningOutputTokens` is
included in `outputTokens`' billing bucket per OpenAI convention but is
broken out — keep totals from `usage`, per-model from
`_meta.quota.model_usage`. `usage.inputTokens` here is *uncached* input
(6189 + 9984 cached ≈ the log's `input_tokens: 16173` total) — note the
asymmetry with Claude, where ACP `inputTokens` is also uncached-only.

Rollout logs (fallback / audit):

- Location: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<sessionId>.jsonl`
  (honors `CODEX_HOME`). **The ACP `sessionId` is embedded verbatim in the
  filename** and equals the log's `session_meta.payload.session_id` —
  correlation demonstrated for captures 1–2.
- Per-turn `event_msg/token_count` entries carry aggregate
  `total_token_usage`/`last_token_usage` plus rate-limit state;
  `turn_context` entries carry `model` + `effort`. A per-model breakdown is
  derivable (turn_context × token_count deltas) but unnecessary given the
  ACP result.

`usage_update` session updates are context-window fill `{used, size}`,
same shape as Claude — not billable deltas.

## Q4: MCP registration

**Classification: works — HTTP transport with headers, exactly our Run Key
shape.** (`mcpCapabilities.http: true`; stdio-command config also
advertised, `sse: false`.)

`session/new` accepted (capture 5):

```json
{"name":"agentdeck","type":"http","url":"http://127.0.0.1:8977/mcp",
 "headers":[{"name":"Authorization","value":"Bearer run-key-test-123"}]}
```

The probe's MCP echo server received `initialize`, `notifications/initialized`,
`tools/list`, and `tools/call` — **every request carried
`Authorization: Bearer run-key-test-123`**. The tool executed and its result
made it into the agent's reply. Bonus: `tools/call` params carry
`_meta["x-codex-turn-metadata"].session_id` matching the ACP session. No
env-var fallback needed.

## Q5: Auth

- **Honored headlessly:** the ChatGPT login state in `~/.codex/auth.json`
  (from `codex login`; `CODEX_HOME` relocates it). All probes ran on a
  plus-plan login with no interactive step.
- **API key:** advertised as ACP `authMethods: [{id: "api-key", …}]`; the
  adapter reads `CODEX_API_KEY` (precedence) or `OPENAI_API_KEY` when that
  method is selected via `authenticate`. `NO_BROWSER=1` hides the
  browser-based ChatGPT method (probe set it; unset, ChatGPT login is also
  offered).
- **Unauthenticated spawn** (capture 6, empty `CODEX_HOME`): the process
  starts and `initialize` succeeds; **`session/new` fails** with a clean
  JSON-RPC error `{"code":-32000,"message":"Authentication required"}`. The
  process does not exit. The Runner already surfaces request errors as the
  run's failure reason, so the operator sees "Authentication required"
  verbatim — legible as required.

## Q6: Quirks

- **No nested-session guard.** All probes ran *inside* a Claude Code
  session with the inherited environment untouched; nothing comparable to
  the `CLAUDECODE` refusal exists. The stub adapter's empty `spawnEnv`
  stands (issue 24 adds `CODEX_CONFIG` for model pinning).
- **Permissions:** in the default `agent` mode, workspace file writes and
  the MCP tool call ran **without a single `session/request_permission`**
  (capture 4: 0 requests). Modes `read-only` / `agent` /
  `agent-full-access` are advertised on `session/new` (and as the `mode`
  config option; `INITIAL_AGENT_MODE` env selects at spawn). Our
  auto-allow handler is still correct as a backstop for `read-only`-ish
  setups; option shapes were not observable in this spike since no request
  fired.
- **Event fidelity** (captures 1, 4, 5):

  | sessionUpdate | Observed | Notes |
  |---|---|---|
  | `agent_message_chunk` | yes | token-granularity `{content:{type:"text",text}}` |
  | `agent_thought_chunk` | yes | reasoning summaries |
  | `tool_call` | yes | `kind: edit/execute/search`, `rawInput`; diffs inline as `content[{type:"diff",oldText,newText,path}]` |
  | `tool_call_update` | yes | status → `completed`, `rawOutput` for MCP calls |
  | `plan` | yes | full-snapshot entries, same shape as Claude |
  | `usage_update` | yes | `{used, size}` context fill |
  | `available_commands_update` | yes | slash commands at session start |
  | `session_info_update` | yes | codex-specific: `_meta.codex.threadStatus` |

- **Tool tally names:** `tool_call` has no `_meta.<harness>.toolName`
  equivalent; titles are human text ("Editing files", "Web search",
  `mcp.<server>.<tool>`), MCP calls flagged `_meta.is_mcp_tool_call: true`.
  The generic `title`/`kind` fallback in the tally is the right source;
  expect coarser buckets than Claude's.
- **toolCallId** prefixes differ by origin (`call_…`, `ws_…`) — treat as
  opaque.

## Recommendation

**Go for issue 24**, with these adjustments over the current guesses:

- Default Codex harness config: `command: npx`,
  `args: ['--yes', '@agentclientprotocol/codex-acp']` — not `codex acp`.
- Codex adapter `spawnEnv(model)`: emit
  `CODEX_CONFIG = {"model": <base>, "model_reasoning_effort": <effort>}`,
  splitting our config's model id on the `model[effort]` grammar (or store
  the two separately in `models`).
- Codex Usage Collector: read totals from the prompt result `usage` and the
  per-model split from `_meta.quota.model_usage` — an ACP-result collector,
  no `sessionLogDir` needed. Keep the rollout-log location documented as
  audit fallback.
- Replace the stale `models` list with verified ids (gpt-5.6-sol/terra/luna,
  gpt-5.5, gpt-5.4, gpt-5.4-mini × effort); consider surfacing
  `session/new`'s `availableModels` to keep it honest per Q7.
