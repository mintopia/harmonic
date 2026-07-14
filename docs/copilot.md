# Copilot Harness: operator notes

Harmonic drives the GitHub Copilot CLI over ACP (`copilot --acp`). These
are the operational facts an operator needs, established by the issue-25
spike and encoded by issue 26.

## Authentication

- The login created by `copilot login` is honored headlessly. On macOS it
  lives in the **system keychain**, not under `~/.copilot` — so a service
  account needs `copilot login` run once as that user, or a token (below).
- Headless token auth: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`,
  using a fine-grained PAT with the **"Copilot Requests"** permission.
- **Trap:** an *invalid* env token silently falls back to any stored
  login instead of failing. Don't rely on a bad token to detach auth.
- Unauthenticated spawns fail the Run with the harness's own
  `Authentication required` error as the failure reason.

## Model pinning is plan-dependent

- Harmonic pins the Task's model via ACP `session/set_model` on every
  run — including `auto`, because an unpinned session inherits the model
  persisted in the operator's `~/.copilot/settings.json`.
- On plans **with model selection** the pin is honored. On **auto-only
  plans** the service accepts the pin and silently routes to its own
  choice — Harmonic surfaces this as a `model_mismatch` event on the run
  (a Task pinned to `auto` accepts any serving model).
- The shipped model list is a snapshot of an entitled plan's
  `availableModels`, minus ids Harmonic has no API-equivalent price for
  (`gemini-*`, `mai-*`). If your plan serves those, add them to
  `harnesses.copilot.models` and give them a `prices` entry — an unpriced
  observed model flags Cost incomplete (a floor, never a fake zero).

## Usage, Cost, and AI Units

- Per-model Usage comes from the CLI's OpenTelemetry file exporter;
  Harmonic points `COPILOT_OTEL_FILE_EXPORTER_PATH` at
  `<dataDir>/copilot-otel/<cwd-slug>.jsonl` (override the root with
  `harnesses.copilot.sessionLogDir`). Usage is attributed to the model
  that actually served each call.
- **AI Units** (Copilot's native consumption unit) are recorded per Run
  from the same spans and shown on the run detail as actual spend
  alongside Cost — never folded into it. Cost stays API-equivalent per
  observed serving model.

## Quirks encoded in the adapter

- `COPILOT_AUTO_UPDATE=false` — the CLI otherwise updates itself between
  runs.
- `--disable-builtin-mcps` (default args) — Runs don't need the built-in
  github-mcp-server, which is a per-session network dependency.
- Operator-level `~/.copilot` plugins and skills load into Runs; isolate
  with `COPILOT_HOME` if unwanted (note: that detaches plugins, not
  keychain auth).
