# Usage and hierarchy from native session-log parsing

Usage and the Process Tree are produced by parsing each Harness's own native
session logs, not from ACP result metadata or OpenTelemetry. Claude and Codex
expose jsonl transcripts (Claude also writes a separate `subagents/agent-*.jsonl`
per Subagent, joined to the parent via a `.meta.json` sidecar's `toolUseId`);
Copilot writes an `events.jsonl` transcript plus a `session-store.db` SQLite
store whose `assistant_usage_events` table carries per-turn tokens, AI Units,
and Subagent attribution. The per-Harness Usage Collector owns this parsing and
emits both Usage and the Process Tree.

We chose this over the previous source — ACP prompt-result aggregates plus a
Copilot OTel file exporter — because ACP only reports end-of-turn aggregates on
the result (no live numbers, no per-Subagent breakdown), and the Claude
`subagents/` layout (new in CLI 2.1.224) means Subagent tokens live in files the
old collector never read: **Run Usage and Cost were undercounting.** The native
logs are written incrementally during execution, carry per-message model+usage,
and expose the parent→Subagent structure — everything the Activity view needs.
AI Units, previously OTel-only, turned out to also live in `session-store.db`,
so OTel can be dropped entirely.

## Considered options

- **ACP result metadata (rejected).** The protocol carries no token/context
  fields on `session/update`; usage exists only on the final `PromptResult`.
  End-only, aggregate-only, no Subagent visibility.
- **OTel for Copilot (rejected).** Coarse (one span per completed call) and a
  parallel mechanism to maintain; its one unique value, AI Units, is also in
  `session-store.db`.
- **Native session-log parsing (chosen).** Live, per-model, Subagent-aware, and
  the only source that fixes the undercount.

## Consequences

- The Usage Collector becomes a native-log parser per Harness; ACP-result and
  OTel reads are removed. Copilot gains a read-only `better-sqlite3` reader over
  `session-store.db` (dependency already present).
- **Parsing is coupled to undocumented, moving log formats.** The 2.1.224
  Claude layout shift is the proof: these formats change under us and a change
  can silently break Usage. This is the accepted cost of this ADR; treat log
  shape as an integration surface and fail loudly (flag incomplete, never a
  fake zero) when a format is unrecognised.
- Codex has no Subagent concept — its Process Tree is a single node.
- Fixing the undercount reprices history the moment logs are re-read; existing
  Runs' Cost may rise once their Subagent tokens are counted.
