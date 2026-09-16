# Decision: Per-Harness unattended permission mode for Attempts

Status: accepted
Date: 2026-09-16

Builds on ADR-0005 (ACP harness, Sessions) and ADR-0025 (per-Harness Adapter
properties / Harness Capability).

## Context

Harmonic runs a Ticket's Attempt by driving a Harness over ACP, unattended
(auto-driven). Before the first prompt it puts the Session into a permission
mode via ACP `session/set_mode` (`src/acp/driver.ts`), chosen from the modes the
Harness advertises at `session/new` (`driver.availableModes`).

Today each Adapter hardcodes that pick:

- `claudeAdapter` / `copilotAdapter` use `['auto','bypassPermissions'].find(...)`
  — `auto` wins whenever advertised, so Claude runs its permission **classifier**
  on every unattended Attempt.
- Over ACP the Claude CLI's `--dangerously-skip-permissions` flag is **ignored**;
  the mode is set only via `session/set_mode`. An operator who set that flag
  still got `auto` and its classifier, with no way to force full bypass and no
  visible signal of which mode actually ran.
- `codexAdapter` already selects `agent-full-access` when advertised;
  `opencodeAdapter` forces `{permission:'allow'}` via env when unattended. Both
  are already at maximum permissiveness for unattended Attempts.

Attempt permission mode is separate plumbing from the Conversation
`ask` / `automatic` mode, though both ultimately call `setMode`.

## Decision

### 1. Permission mode is per-Harness configuration

Add an optional `permissionMode` to each Harness's config
(`harnessConfigSchema`, `src/config.ts`). Absent = the Adapter's current default
pick, so existing setups are unchanged.

### 2. Each Harness owns its mode vocabulary

The control and its labels are Harness-specific, not a universal boolean. An
Adapter declares the modes it offers for configuration (ACP mode id →
operator-facing label) and its default:

- **Claude**: `auto` (default, "Auto") vs `bypassPermissions` ("Bypass
  Permissions"). Bypass runs with no prompts and no classifier.
- **Copilot**: the modes it advertises at runtime, friendly-labelled once
  observed.
- **Codex / OpenCode**: no control — already maximally permissive for unattended
  Attempts; a toggle could only make them less so.

### 3. Scope: unattended Attempts only

The setting governs the auto-driven Attempt path (`runner.ts`). Conversations
keep their own `ask` / `automatic` mode: a human is present and can approve.

### 4. Best-effort application with a visible effective mode

Runner applies the configured mode. If the Harness does not advertise it at
runtime, fall back to the most-permissive advertised mode (never one that would
stall an unattended Attempt). The **effective** mode is recorded on the Attempt
timeline every run, and requested / advertised / chosen / fallback detail is
logged. In-app logs are invisible to operators, so the timeline is the primary
surface.

## Consequences

- Operators can force Claude/Copilot Attempts to bypass the classifier; the
  default stays `auto`, so nothing changes until opted in.
- The Attempt timeline finally shows which permission mode ran — closing a
  standing opacity gap.
- Adding a Harness means declaring its configurable modes + labels, or declaring
  none.
