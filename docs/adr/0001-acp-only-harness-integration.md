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
