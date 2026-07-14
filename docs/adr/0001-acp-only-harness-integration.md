# ACP is the only harness integration protocol

AgentDeck drives all harnesses (Claude, Codex, Copilot) exclusively over
ACP (Agent Client Protocol) — stdio JSON-RPC with structured streaming.
We deliberately do not support the harnesses' one-shot CLI modes
(`claude -p`, `codex exec`, `copilot -p`), even as a fallback: one code
path, uniform real-time observability (tool calls, thoughts, plans), and
no second-class degraded mode to maintain.

## Consequences

- We depend on each vendor's ACP implementation staying healthy
  (Claude via the `claude-code-acp` adapter, Codex and Copilot natively).
- ACP does not standardize token usage, so Usage is collected from ACP
  extension/_meta fields where emitted, falling back to parsing the
  harness's native session logs on disk (per-harness UsageCollector).
