---
title: ACP & harness adapters
---

Harmonic drives every coding agent (Claude, Codex, Copilot) exclusively over
**ACP (Agent Client Protocol)** — stdio JSON-RPC with structured streaming.
See [ACP](https://agentclientprotocol.com). This is a deliberate design
decision — see [ADR 0001](/harmonic/how-it-works/design-decisions/).

## Why ACP only

Harmonic does not use the harnesses' one-shot CLI modes (`claude -p`,
`codex exec`, `copilot -p`), even as a fallback:

- One code path.
- Uniform real-time observability (tool calls, thoughts, plans).
- No second-class degraded mode.

Amendment: neither Claude nor Codex speaks ACP natively — both go through
canonical vendor adapter packages, `@agentclientprotocol/claude-agent-acp`
and `@agentclientprotocol/codex-acp`, which are part of the vendor surface
Harmonic depends on.

## The Harness Adapter contract

A **Harness Adapter** is the per-harness code module behind which all
harness-specific knowledge lives — spawn tweaks (quirk workarounds), the
model pin, and the Usage Collector. It's keyed by Harness; operator config
holds only what is genuinely operator-tunable.

Adapters live in `src/execution/harness/`: `adapter.ts` (the contract +
registry), `claude.ts`, `codex.ts`, `copilot.ts`.

```ts
interface HarnessAdapter {
  spawnEnv(input: SpawnInput): Record<string, string | undefined>;   // env overlay: model pin + quirk workarounds
  sessionModelId?(model: string): string;                            // ACP modelId for session/set_model (Copilot only)
  mcpServers(input: { url: string; token: string }): unknown[];      // ACP session/new mcpServers entries
  usage: UsageCollector | null;                                      // per-harness Usage Collector, or null
}
```

Where `SpawnInput = { model: string; cwd: string; sessionLogDir?: string }`.

## The registry

Adapters are keyed by HarnessId:

```ts
// src/config.ts
export const HARNESS_IDS = ['claude', 'codex', 'copilot'] as const;

// src/execution/harness/adapter.ts
const adapters: Record<HarnessId, HarnessAdapter> = { claude: claudeAdapter, codex: codexAdapter, copilot: copilotAdapter };
export function adapterFor(harnessId: string): HarnessAdapter // unknown ids -> a no-op unknownAdapter
```

## Where the adapters differ

Cross-cutting concerns ACP does not standardize, and how adapters fill the
gap:

- **Model selection**: spawn-time env for Claude/Codex; for Copilot the
  adapter calls ACP `session/set_model` right after `session/new` (its
  spawn-time flags are ignored/misleading in `--acp` mode). The observed
  model is verified from Usage and any contradiction is surfaced on the Run.
- **Usage/token accounting**: taken from ACP extension/`_meta` fields where
  emitted, else from parsing the harness's native session logs on disk
  (per-harness Usage Collector). Copilot emits usage on neither surface, so
  its adapter switches on a per-run OpenTelemetry file exporter at spawn via
  `COPILOT_OTEL_FILE_EXPORTER_PATH`.

The full rationale and its amendments live in
[ADR 0001](/harmonic/how-it-works/design-decisions/).
