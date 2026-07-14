# Spike findings: Copilot ACP fidelity

Status: done
Date: 2026-07-14
Probe: `.scratch/agentdeck-v1/spike/copilot-probe.mjs` + `spike/mcp-echo-server.mjs`
(raw captures in `spike/capture-copilot-*.jsonl`; MCP-side request log in
`spike/capture-copilot-5-mcp-server.log`; OTel span evidence in
`spike/capture-copilot-otel-excerpts.txt`; session-log correlation and
actual-model evidence in `spike/capture-copilot-sessionlog-excerpts.txt`)

Probed against GitHub Copilot CLI 1.0.69 (auto-updated itself to 1.0.70
mid-spike — see Quirks) on a real operator login.

## Headline

**Recommendation: go for issue 26 — but as an auto-model harness.** The
entry point in `defaultConfig()` is already right (`copilot --acp`),
streaming and MCP fidelity are high, and per-model usage *plus per-Run AI
Units* are observable via the CLI's OpenTelemetry file exporter. The bad
news is model pinning: on the probed account **no model can be pinned at
all** — every mechanism is either ignored in ACP mode or silently
overridden server-side — so per decision Q7 the Copilot `models` list must
collapse to `auto` (no dropdown that lies).

## Q1: Entry point and protocol revision

**Classification: `copilot --acp` is real and speaks ACP on stdio.** No
adapter package needed (unlike Codex).

- `initialize {protocolVersion: 1}` → accepted and echoed
  (`"protocolVersion":1`), with `agentInfo {name: "Copilot", version: "1.0.69"}`.
- Capabilities: `promptCapabilities {embeddedContext, image}` (no audio),
  `mcpCapabilities {http: true, sse: true}`, `loadSession: true`,
  `sessionCapabilities {list}`.
- `authMethods: [{id: "copilot-login", …}]` with a `_meta["terminal-auth"]`
  hint pointing at the CLI's `login` subcommand.
- ndjson JSON-RPC on stdio; handshake identical to Claude/Codex:
  `initialize` → `session/new {cwd, mcpServers}` → `session/prompt` →
  `{stopReason: "end_turn"}`. Process stays alive after the turn; closing
  stdin ends it cleanly (exit 0).
- `session/new` returns `modes` (agent / plan / autopilot) and
  `configOptions` (mode, allow_all, plus an `agent` select listing the
  operator's installed custom agents). **No `models` key** — see Q2.

## Q2: Model pinning

**Classification: not pinnable on the probed account — collapse the
`models` list to `auto` per Q7.** Three mechanisms probed, none pins:

1. **`--model` CLI flag: ignored in `--acp` mode** (capture 3): spawned
   with `--model claude-haiku-4.5`, session stayed `auto` and was served by
   `gpt-5-mini`. (In non-ACP `-p` mode the same flag is *validated* — see
   below.) Oddly, `--effort low` at spawn IS honored
   (`session.start.reasoningEffort: "low"`, capture 2).
2. **`COPILOT_MODEL` env: ignored in `--acp` mode** (capture 8): spawned
   with `COPILOT_MODEL=gpt-5.4`, session stayed `auto`, served by
   `claude-haiku-4.5`.
3. **ACP `session/set_model`: accepted but not honored.** It returns `{}`
   for *anything* — including `modelId: "not-a-real-model"` (capture 4) —
   and does change the requested model (the OTel span's
   `gen_ai.request.model` and the session log's `session.model_change`
   both show the set value). But the service routes to its own choice
   anyway: `set_model gpt-5.4` → served by `claude-haiku-4.5` (capture 9),
   `set_model claude-sonnet-4.5` → served by `claude-haiku-4.5`
   (capture 10). No error is ever surfaced.

The root cause appears to be plan gating, and the fallback is silent. The
non-ACP path validates: `copilot -p … --model claude-haiku-4.5` (or any
other id, including models that demonstrably serve responses) fails with
*"Model … from --model flag is not available"* on this account — i.e. the
account's selectable-model list is empty and only `auto` is allowed. The
router's actual candidate set is visible in the session log's
`session.auto_mode_resolved` event: `candidateModels:
["claude-haiku-4.5", "gpt-5-mini"]` with per-category scores. Whether
`session/set_model` pins correctly on a plan *with* model selection could
not be verified from this account.

Actual-model verification (the part that works, on two surfaces):

- Native session log: every `assistant.message` event carries
  `data.model` — the model that actually produced that message.
- OTel chat spans: `gen_ai.response.model` per LLM call (with
  `gen_ai.request.model` alongside, so requested-vs-served divergence is
  directly observable).

## Q3: Usage

**Classification: OTel file exporter — the ACP result and the session log
both come up empty.**

- The `session/prompt` **result is bare**: `{"stopReason":"end_turn"}` —
  no `usage`, no `_meta` (capture 1). Worse than both Claude and Codex.
  No `usage_update` session updates were observed either (not even
  context-window fill).
- The native session log
  `~/.copilot/session-state/<sessionId>/events.jsonl` — **the ACP
  `sessionId` is the directory name verbatim**, correlation demonstrated
  for every capture — records models, turns, and tool calls but **no
  token counts**. The one event that does carry per-model usage and
  premium-request totals (`session.shutdown` with `modelMetrics`) is
  *not written for ACP sessions*, even on a clean stdin-close exit
  (captures 2, 6b: `childExit 0`, no shutdown event).
- **The working source**: spawn with
  `COPILOT_OTEL_FILE_EXPORTER_PATH=<per-run file>` (JSON-lines, offline,
  auto-enables OTel). Each LLM call emits a `chat` span:

```json
{"type":"span","name":"chat auto","attributes":{
  "gen_ai.operation.name":"chat","gen_ai.provider.name":"github",
  "gen_ai.request.model":"auto","gen_ai.response.model":"gpt-5-mini",
  "gen_ai.conversation.id":"574df71c-25b3-4829-b01a-4dc8d50f47e8",
  "gen_ai.usage.input_tokens":35068,"gen_ai.usage.output_tokens":4539,
  "gen_ai.usage.reasoning.output_tokens":4480,
  "github.copilot.cost":0.0,"github.copilot.nano_aiu":1784500000.0,
  "github.copilot.turn_id":"0", …}}
```

  Mapping for the Usage Collector: aggregate spans by
  `gen_ai.response.model` (attributing to the model that actually served —
  exactly what Usage should say). **The cache split is present but
  omit-when-zero**: `gen_ai.usage.cache_read.input_tokens` →
  cacheReadTokens and `gen_ai.usage.cache_creation.input_tokens` →
  cacheWriteTokens appear only on spans where they're non-zero (first call
  of capture 3 has neither; later calls carry cache_read ≈ the whole
  prompt; haiku spans carry both — see the excerpts). `input_tokens` is
  **total** input (≈ cache_read + cache_creation + uncached; capture 8:
  48497 ≈ 38829 + 9659 + uncached), so ModelUsage.inputTokens =
  `input_tokens − cache_read − cache_creation` to keep the uncached-input
  convention Claude and Codex use. `output_tokens` maps directly;
  `reasoning.output_tokens` is broken out but included in output per
  convention.
  `gen_ai.conversation.id` equals the ACP `sessionId`, so the file can be
  double-checked even though a per-run path already isolates it.
- Rate limiting: usage-limit progress and the AI Unit budget (the CLI's
  billing help calls them "AI credits") exist in the CLI UI but not on
  the ACP surface.

## Q4: MCP registration

**Classification: works — HTTP transport with bearer headers, exactly our
Run Key shape** (`mcpCapabilities {http: true, sse: true}`).

`session/new` accepted (capture 5):

```json
{"name":"agentdeck","type":"http","url":"http://127.0.0.1:8978/mcp",
 "headers":[{"name":"Authorization","value":"Bearer run-key-test-123"}]}
```

The probe's MCP echo server received `initialize`
(`clientInfo {name: "github-copilot-developer"}`),
`notifications/initialized`, `tools/list`, and `tools/call` — **every
request carried `Authorization: Bearer run-key-test-123`**. The tool
executed, its result streamed back as a `tool_call_update` with
`rawOutput`, and made it into the agent's reply verbatim. One
`session/request_permission` fired for the MCP call and the Runner-style
auto-allow handled it. No env-var fallback needed.

Note: the CLI also spawns its **built-in github-mcp-server** on every
session (a network dependency and extra tool surface);
`--disable-builtin-mcps` exists if issue 26 wants leaner sessions.

## Q5: Auth

- **Honored headlessly:** the login created by `copilot login`, which on
  macOS lives in the **system credential store (keychain)** — *not* under
  `~/.copilot`. Consequences, all probed: `COPILOT_HOME` pointing at an
  empty directory does **not** detach auth (capture 6b still answered);
  an **invalid `COPILOT_GITHUB_TOKEN` silently falls back** to the stored
  login (capture 6 — the documented env-token precedence is not honored
  when the token is bad). Headless token auth (`COPILOT_GITHUB_TOKEN` >
  `GH_TOKEN` > `GITHUB_TOKEN`; fine-grained PATs with the "Copilot
  Requests" permission) is the documented mechanism for
  operator-provisioned environments.
- **Unauthenticated spawn** (capture 6c, empty `HOME` so no keychain):
  the process starts and `initialize` succeeds (advertising the
  `copilot-login` auth method); **`session/new` fails** with a clean
  JSON-RPC error `{"code":-32000,"message":"Authentication required"}` —
  byte-identical to Codex's failure shape. The Runner already surfaces
  request errors as the run's failure reason, so the operator sees
  "Authentication required" verbatim — legible as required, no adapter
  work needed.
- **Env-token negative case** (capture 6d): a valid GitHub CLI OAuth
  token *without* Copilot entitlement (`gh auth token`, scopes gist/
  project/read:org/repo/workflow) passed as `COPILOT_GITHUB_TOKEN` with
  the keychain detached fails the same way — `session/new` →
  `-32000 "Authentication required"`. The happy path (a fine-grained PAT
  with the "Copilot Requests" permission) is documented but was **not
  verifiable on this machine**; issue 26 should confirm it when the
  operator provisions one.

## Q6: Quirks

- **No nested-session guard.** All probes ran *inside* a Claude Code
  session with the inherited environment untouched (same setup that
  trips Claude's `CLAUDECODE` refusal); every session worked. Nothing
  sandbox- or nesting-related surfaced.
- **Auto-update on spawn.** The CLI updated itself 1.0.69 → 1.0.70
  *between two probe runs* (visible in `agentInfo.version`). For
  reproducible Runs the adapter should set `COPILOT_AUTO_UPDATE=false`.
- **Operator-level plugins leak in.** Sessions load `~/.copilot` installed
  plugins and skills: the probe's turns auto-invoked a `using-superpowers`
  skill, and `session/new`'s `agent` configOption enumerated the
  operator's custom agents. `--no-custom-instructions` covers instruction
  files; plugins follow `COPILOT_HOME`. Worth deciding in issue 26 whether
  Runs should see the operator's plugin set.
- **Permissions:** file writes fire `session/request_permission` with
  options `allow_once` / `allow_always` / `reject_once` (kinds match
  names); reads don't ask; the MCP tool call asked once. The Runner's
  auto-allow (prefer `allow_always`) works unchanged. `--allow-all-tools`
  or the `allow_all` configOption / autopilot mode exist as alternatives.
- **Event fidelity** (captures 1, 3, 5):

  | sessionUpdate | Observed | Notes |
  |---|---|---|
  | `agent_message_chunk` | yes | token-granularity text |
  | `agent_thought_chunk` | no | reasoning is opaque/encrypted in the log; nothing streamed |
  | `tool_call` | yes | `kind: edit/read/other`, `rawInput`, `locations`; title is human text |
  | `tool_call_update` | yes | status → `completed`/`failed`, `rawOutput` (MCP calls included) |
  | `plan` | not observed | plan mode not probed |
  | `usage_update` | no | nothing usage-shaped on the ACP surface |
  | `available_commands_update` | yes | twice per session start |
  | `config_option_update` | yes | mode/allow_all/agent selects |
- **Tool tally names:** no `_meta.<harness>.toolName`; MCP calls are
  titled `<server>-<tool>` (`agentdeck-agentdeck_echo`), built-ins get
  human titles ("Creating …/hello.txt"). The generic `title`/`kind`
  fallback is the right source, same as Codex.
- **toolCallId** prefixes vary by upstream provider (`call_…`,
  `toolu_bdrk_…`) — treat as opaque.
- **Non-model turn failures are legible in-stream:** a failing skill/tool
  produces `tool_call_update {status: "failed", rawOutput.message}` and
  the turn continues.

## Q7 (Copilot-specific): AI Units observability

**Classification: per-Run observable — ship the optional Usage field.**

Two per-call attributes on every OTel `chat` span (nothing equivalent on
the ACP surface or in the ACP-session event log):

- `github.copilot.nano_aiu` — AI Units consumed, in nano-units. Observed:
  `1784500000` (≈1.78 AIU) and `259855000` (≈0.26 AIU) for two gpt-5-mini
  calls; `6135150000` (≈6.14 AIU) for a claude-haiku-4.5 tool-use turn;
  `1654565000`/`1636815000`/`1695065000` (≈1.6–1.7 AIU) for trivial haiku
  turns. Sum across a Run's spans ÷ 1e9 = the Run's AI Unit consumption.
- `github.copilot.cost` — the legacy premium-request multiplier for that
  call (`0.0` for gpt-5-mini, `0.33` for claude-haiku-4.5), matching the
  `session.shutdown.modelMetrics[].requests.cost` figures seen in
  interactive sessions.

Per the decision (planning session 2026-07-14): surfaced as an optional
Usage field — actual spend alongside Cost — never a Cost input.

## Recommendation

**Go for issue 26**, with these adjustments over the current guesses:

- `defaultConfig()` copilot entry: `command: copilot, args: ['--acp']` is
  already correct. Replace the stale `models: ['claude-sonnet-5', 'gpt-5.2']`
  with **`['auto']`** and `defaultModel: 'auto'` (Q2: nothing else is
  honored on the probed account; `gpt-5.2` doesn't exist at all). The Task
  form should show Copilot's model as fixed `auto` — no dropdown that lies.
  Revisit if an entitled plan verifies `session/set_model` pinning; the
  documented id list lives in `copilot help config` (21 ids at probe time).
- Copilot adapter `spawnEnv()`: `COPILOT_AUTO_UPDATE: 'false'` plus
  `COPILOT_OTEL_FILE_EXPORTER_PATH` pointed at a per-run file — which means
  **`spawnEnv` needs the run's workdir (or a run-scoped path) as input**,
  an additive `HarnessAdapter` interface change in the spirit of issue
  24's `modelsFromPromptResult` hook. The Usage Collector's
  `sessionLogFile()` can derive the same path from its `cwd` input, so the
  existing collector interface fits with no further changes:
  `modelsFromSessionLog` parses OTel chat spans (aggregate by
  `gen_ai.response.model`, cache fields from the omit-when-zero
  `cache_read`/`cache_creation` attributes, uncached input = total minus
  both), and per-Run AI Units fall out of the same parse (`nano_aiu`).
- Because the pin isn't honored, the Task's `auto` model will *always*
  differ from the serving model — the issue-24 `model_mismatch` machinery
  should treat `auto` as matching anything, and the run should surface
  the observed model(s) as information, not as a mismatch warning.
- Auth needs zero adapter work (`session/new` errors legibly), but
  document for operators: on macOS the login lives in the keychain (a
  service account needs `copilot login` once, or a fine-grained PAT via
  `COPILOT_GITHUB_TOKEN`), and a *bad* env token silently falls back to
  any stored login rather than failing.
- Consider `--disable-builtin-mcps` (leaner, no GitHub MCP network
  dependency) and a decision on operator plugins leaking into Runs
  (`COPILOT_HOME` isolation cuts both ways: it detaches plugins but not
  keychain auth).
- Cost: `auto` has no single per-model price, but Usage's per-model
  breakdown (from OTel spans) prices each serving model normally, so Cost
  stays API-equivalent per decision Q4 — `DEFAULT_PRICES` needs entries
  for the observed router candidates (`claude-haiku-4.5`, `gpt-5-mini`)
  and whatever else the router picks over time; an unpriced observed
  model correctly flags Cost incomplete.
