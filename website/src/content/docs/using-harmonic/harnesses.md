---
title: Harnesses
description: Configuring and operating the Claude, Codex, and Copilot harnesses — spawn commands, auth, model pinning, and Usage.
---

Harmonic drives all three harnesses — Claude, Codex, Copilot — over ACP.
Each is configured under `harnesses.<id>` in config, where `<id>` is
`claude`, `codex`, or `copilot`. This page is the operator/setup view; for
the adapter architecture behind it see
[ACP & harness adapters](/harmonic/how-it-works/acp-and-adapters/) and
[ADR 0001](/harmonic/how-it-works/design-decisions/).

## Per-harness config shape

`harnessConfigSchema` in `src/config.ts`:

| Field | Type | Notes |
| --- | --- | --- |
| `command` | `string` | Executable to spawn |
| `args` | `string[]` | Arguments passed at spawn |
| `env` | `Record<string, string>` | Extra environment for the spawned process, e.g. API keys |
| `models` | `string[]` | Selectable models |
| `defaultModel` | `string` | Must be one of `models` when any are listed |
| `sessionLogDir` | `string` (optional) | Root of the harness's native session logs, used for the per-model Usage fallback; empty string disables |

See [Settings & overrides](/harmonic/using-harmonic/settings-and-overrides/)
for where harness config lives.

For all three harnesses, Harmonic registers its own MCP server (`harmonic`)
over ACP `session/new` with a bearer token — zero operator MCP setup
needed.

## Claude

- `command: npx`, `args: ['--yes', '@agentclientprotocol/claude-agent-acp']`
  — Claude doesn't speak ACP natively, so this goes through the vendor ACP
  adapter.
- `sessionLogDir` default: `~/.claude/projects`.
- Auth via the Claude Code CLI login, or `ANTHROPIC_API_KEY` in `env`.
- The adapter pins the model via `ANTHROPIC_MODEL` at spawn, and refuses to
  start nested inside a Claude Code session (unsets `CLAUDECODE` /
  `CLAUDE_CODE_ENTRYPOINT`).

## Codex

- `command: npx`, `args: ['--yes', '@agentclientprotocol/codex-acp']` — note
  that `codex acp` is **not** a subcommand; this goes through the vendor ACP
  adapter.
- Model and reasoning effort are pinned at spawn via a `CODEX_CONFIG` env
  JSON: `{ model, model_reasoning_effort }`.
- Auth via the Codex CLI login, or `OPENAI_API_KEY` in `env`.

## Copilot

- `command: copilot`, `args: ['--acp', '--disable-builtin-mcps']` — Copilot
  speaks ACP natively via `copilot --acp`.

### Authentication

- The login created by `copilot login` is honored headlessly. On macOS it
  lives in the **system keychain**, not under `~/.copilot` — so a service
  account needs `copilot login` run once as that user, or a token (below).
- Headless token precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` >
  `GITHUB_TOKEN`, using a fine-grained PAT with the **"Copilot Requests"**
  permission.
- Trap: an *invalid* env token silently falls back to a stored login
  instead of failing.
- Unauthenticated spawns fail the Run with `Authentication required` as the
  failure reason.

### Model pinning is plan-dependent

Harmonic pins the model via ACP `session/set_model` on every run —
including `auto` — because an unpinned session inherits whatever model is
persisted in the operator's `~/.copilot/settings.json`. Copilot's spawn-time
flags are ignored in `--acp` mode.

| Plan | Pin behavior |
| --- | --- |
| Model selection available | Pin is honored |
| Auto-only | Service accepts the pin, then silently routes to its own choice — surfaced as a `model_mismatch` event on the run |

The shipped model list is a snapshot of an entitled plan's
`availableModels`, minus ids with no API-equivalent price (`gemini-*`,
`mai-*`). To serve those, add them to `harnesses.copilot.models` plus a
`prices` entry — an unpriced observed model flags Cost incomplete, a floor,
never a fake zero.

### Usage, Cost, and AI Units

Per-model Usage is read from Copilot's native store,
`~/.copilot/session-store.db` (`assistant_usage_events` table, keyed by
session id); override the `~/.copilot` root with
`harnesses.copilot.sessionLogDir`. Usage is attributed to the model that
actually served each call, and Subagent rows (`parent_tool_call_id`) roll
up into the Run ([ADR 0009](/harmonic/how-it-works/design-decisions/)).

**AI Units** — Copilot's native consumption unit — come from the same rows
(`total_nano_aiu`) and are shown on the run detail as actual spend alongside
Cost, never folded into it. Cost stays API-equivalent per observed serving
model.

Rows land per completed call, so live Usage updates coarsely — one step per
Copilot turn. Subagent name and live status come from
`~/.copilot/session-state/<id>/events.jsonl`.

### Quirks encoded in the adapter

- `COPILOT_AUTO_UPDATE=false` — the CLI otherwise self-updates between
  runs.
- `--disable-builtin-mcps` in the default args — Runs don't need the
  built-in github-mcp-server, a per-session network dependency.
- Operator-level `~/.copilot` plugins and skills load into Runs; isolate
  with `COPILOT_HOME` if unwanted (note: that detaches plugins, not
  keychain auth).
