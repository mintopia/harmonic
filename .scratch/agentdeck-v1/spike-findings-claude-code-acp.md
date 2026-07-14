# Spike findings: claude-code-acp fidelity

Status: done
Date: 2026-07-14
Probe: `.scratch/agentdeck-v1/spike/acp-probe.mjs` (raw captures in `spike/capture-*.jsonl`)

## Headline

**Recommendation: proceed as designed — but pin the adapter package.**

The npm package literally named `claude-code-acp` (the name used in the PRD)
is a **third-party adapter ("cc-acp" 0.1.1) with unacceptable fidelity**:
it emits only `agent_message_chunk` updates (no tool calls, no plans, no
usage), prints debug noise on stdout interleaved with the JSON-RPC stream,
and in our probe claimed to have written a file that was never written.

The canonical adapter is Zed's, now renamed
**`@agentclientprotocol/claude-agent-acp`** (formerly
`@zed-industries/claude-code-acp`; probed at 0.16.x). Everything below
describes that adapter. The Claude harness config must spawn
`npx @agentclientprotocol/claude-agent-acp` (or a pinned install), never
the bare `claude-code-acp` name.

## Q1: Which `session/update` types are emitted, and payload shapes

Observed across probes 2 and 3 (basic file-write prompt; plan + subagent
prompt):

| sessionUpdate | Observed | Notes |
|---|---|---|
| `agent_message_chunk` | yes | `{content: {type:"text", text}}` |
| `tool_call` | yes | see shape below |
| `tool_call_update` | yes | status transitions + `content`/`rawOutput` deltas |
| `plan` | yes | full-snapshot entries list, re-sent on every change |
| `usage_update` | yes | `{used, size}` context-window fill, sometimes `_meta["_claude/rateLimit"]` |
| `available_commands_update` | yes | slash-command list at session start |
| `agent_thought_chunk` | not observed | thinking wasn't triggered in probes; render if it arrives |

`tool_call` sample (probe 2):

```json
{"_meta":{"claudeCode":{"toolName":"Write"}},
 "toolCallId":"toolu_01UPHXmUqnEQquYqy2PFLMry",
 "sessionUpdate":"tool_call","rawInput":{},
 "status":"pending","title":"Write","kind":"edit",
 "content":[],"locations":[]}
```

`plan` sample (probe 3):

```json
{"sessionUpdate":"plan","entries":[
  {"content":"Launch subagent to create sub.txt with 'from-subagent'",
   "status":"pending","priority":"medium"}]}
```

Statuses on tool calls run `pending` → `in_progress` → `completed`/`failed`
via `tool_call_update`. `kind` values seen: `edit`, `read`, `think`,
`other`.

**Implication for Run Events:** persist the update objects verbatim
(discriminated by `sessionUpdate`) — they are self-describing and render
directly. Plan updates are snapshots, not deltas, so replay is trivial.

## Q2: Subagent activity

**Classification: partial — good enough as designed.**

A subagent launched via the Task tool surfaces as:

1. A `tool_call` with `title:"Task"`, `_meta.claudeCode.toolName:"Agent"`.
2. The subagent's own tool calls arrive as ordinary `tool_call` /
   `tool_call_update` events carrying
   `_meta.claudeCode.parentToolUseId:"<the Task toolCallId>"`.

Sample (probe 3):

```json
{"title":"Write sub.txt","kind":"edit",
 "_meta":{"claudeCode":{"toolName":"Write",
          "parentToolUseId":"toolu_012PMz6oq16LRqHW3s31TgNu"}}}
```

The subagent's *text/thinking* is not streamed, only its tool calls. The
UI can nest subagent tool calls under the parent Task call using
`parentToolUseId`. This satisfies "to the extent the Harness exposes it
over ACP".

## Q3: Token usage

**Classification: ACP metadata available (aggregate); session-log fallback
needed for per-model breakdown.**

- The `session/prompt` **result** includes aggregate usage:
  `{"stopReason":"end_turn","usage":{"inputTokens":55,"outputTokens":1403,
  "cachedReadTokens":385226,"cachedWriteTokens":39741,"totalTokens":426425}}`.
  This is per-prompt-turn, all models merged.
- `usage_update` session updates report context-window fill
  (`{used, size}`), not billable token deltas.
- **Per-model** usage (the PRD asks for tokens *per model*) is not on the
  ACP surface. It is cleanly parseable from Claude Code's native session
  log: `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl`, where each
  assistant message carries `message.model` and `message.usage`
  (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, …). **The ACP `sessionId` equals the log
  filename**, and the directory slug is the run's cwd with `/` and `.`
  replaced by `-` — so the fallback collector can locate the file
  deterministically.
- Tool-call tallies: count `tool_call` Run Events; no log parsing needed.

UsageCollector design confirmed: ACP result usage first (always present),
session-log parse for the per-model split; report "unavailable" only if
both missing.

## Q4: Lifecycle quirks the adapter must handle

1. **Nested-session guard.** The adapter (via the Claude Code SDK) refuses
   to start when `CLAUDECODE` is set: *"Claude Code cannot be launched
   inside another Claude Code session."* AgentDeck may itself be started
   from a Claude session, so the harness adapter must strip
   `CLAUDECODE` (and `CLAUDE_CODE_ENTRYPOINT`) from the child env.
2. **Permission prompts.** File edits outside auto-allowed scope arrive as
   `session/request_permission` client-bound *requests* with options
   (`allow_once`/`allow_always`/`reject_once`/…). Unattended operation
   must either respond programmatically or select a permissive session
   mode — `session/new` returns modes `default`, `acceptEdits`,
   `bypassPermissions`, `plan`, `auto`; mode can be set via
   `session/set_mode`. AgentDeck should default to auto-approving (it is
   an unattended runner by design) and log each grant as a Run Event.
3. **Client capabilities matter.** With `fs.writeTextFile` advertised, the
   adapter routes file writes through the client (`fs/write_text_file`).
   AgentDeck should advertise **no** fs capabilities so the harness does
   its own I/O in the working directory.
4. **Handshake.** `initialize` (protocolVersion 1) → `session/new {cwd,
   mcpServers}` → `session/prompt {sessionId, prompt:[{type:"text",text}]}`
   → result `{stopReason, usage}`. Messages are newline-delimited JSON on
   stdio. `stopReason:"end_turn"` on success; the process stays alive for
   further prompts and must be killed by the client.
5. **Auth.** With no `CLAUDE_API_KEY`/`ANTHROPIC_API_KEY`, the adapter
   falls back to the local Claude Code subscription login. Fresh
   workspaces need either an API key in the harness env or a completed
   `claude` login; otherwise `initialize` advertises an `authMethods`
   list and prompting fails until `authenticate`.
6. **Package naming trap.** See headline: `claude-code-acp` on npm ≠ the
   Zed/official adapter. Pin `@agentclientprotocol/claude-agent-acp`.

## Recommendation

**Go.** Build the execution slice as designed (ADR-0001 stands), with
three design adjustments folded in:

- Spawn `@agentclientprotocol/claude-agent-acp` for the Claude harness;
  treat the adapter package/version as harness config, not a constant.
- Strip `CLAUDECODE*` env vars when spawning; auto-respond to
  `session/request_permission` (configurable, default allow) and persist
  each grant as a Run Event.
- UsageCollector: read aggregate usage from the `session/prompt` result
  (cheap, always there), enrich with per-model breakdown from
  `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`.
