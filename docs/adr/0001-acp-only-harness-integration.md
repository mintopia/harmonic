# ACP is the only harness integration protocol

AgentDeck drives all harnesses (Claude, Codex, Copilot) exclusively over
ACP (Agent Client Protocol) — stdio JSON-RPC with structured streaming.
We deliberately do not support the harnesses' one-shot CLI modes
(`claude -p`, `codex exec`, `copilot -p`), even as a fallback: one code
path, uniform real-time observability (tool calls, thoughts, plans), and
no second-class degraded mode to maintain.

## Consequences

- We depend on each vendor's ACP implementation staying healthy.
  (Amended 2026-07-14, issues 01/22: neither Claude nor Codex speaks ACP
  natively after all — both go through canonical adapter packages,
  `@agentclientprotocol/claude-agent-acp` and
  `@agentclientprotocol/codex-acp`. The ACP-only decision is unchanged;
  the adapters are part of the vendor surface we depend on.)
- ACP does not standardize token usage, so Usage is collected from ACP
  extension/_meta fields where emitted, falling back to parsing the
  harness's native session logs on disk (per-harness UsageCollector).
  (Amended 2026-07-14, issue 25: Copilot emits usage on *neither*
  surface — its ACP result is bare and its ACP-session event log has no
  token counts. The UsageCollector's "log on disk" is, for Copilot, a
  per-run OpenTelemetry file exporter the adapter switches on at spawn
  (`COPILOT_OTEL_FILE_EXPORTER_PATH`). Same decision, third shape of the
  vendor surface we depend on.)
- ACP also doesn't standardize model selection, so the Task-model pin is
  a Harness Adapter concern: spawn-time env for Claude/Codex, and — per
  issues 25/26 — ACP `session/set_model` right after `session/new` for
  Copilot (its spawn-time flags are ignored or misleading in `--acp`
  mode). Either way the observed model is verified from Usage and a
  contradiction is surfaced on the Run.
