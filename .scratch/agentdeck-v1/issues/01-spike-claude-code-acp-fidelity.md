# Spike: claude-code-acp fidelity

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

A timeboxed spike, not production code. Drive the `claude-code-acp` adapter
over ACP with a real prompt and record what actually comes back, so we know
whether the observability and statistics features can be built as designed
(per ADR-0001, ACP is the only integration path — there is no fallback).

Answer specifically:

- Which ACP `session/update` types the adapter emits (message chunks,
  thoughts, tool calls, plan updates) and with what payload shape.
- Whether subagent activity is surfaced at all, and in what form.
- Whether token usage appears in ACP `_meta`/extension fields, and if not,
  where in Claude Code's native session logs it can be parsed from.
- Any lifecycle quirks (session setup, permission prompts, exit behavior)
  that the Harness adapter must handle.

The deliverable is a findings note committed under the feature directory,
with raw sample payloads, plus a recommendation: proceed as designed, or
adjust the Usage/observability design before the execution slice goes deep.

## Acceptance criteria

- [x] A findings document exists covering all four questions above with real captured payloads
- [x] Usage availability is classified: ACP metadata, session-log fallback, or unavailable
- [x] Subagent visibility is classified: full, partial (describe), or none
- [x] A clear go/adjust recommendation for the Run execution and Usage slices

## Blocked by

None - can start immediately

## Comments

**2026-07-14 (agent):** Spike complete. Findings in
`.scratch/agentdeck-v1/spike-findings-claude-code-acp.md`, probe script and
raw captures in `.scratch/agentdeck-v1/spike/`. Verdict: **go**, with the
adapter pinned to `@agentclientprotocol/claude-agent-acp` (the bare npm
name `claude-code-acp` is a low-fidelity third-party package). Usage:
aggregate on the ACP prompt result, per-model via session-log fallback.
Subagents: partial (tool calls nested via `parentToolUseId`). Quirks:
strip `CLAUDECODE` env, auto-answer `session/request_permission`.
