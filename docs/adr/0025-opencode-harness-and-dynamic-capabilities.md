# Decision: OpenCode harness and dynamic harness capabilities

Status: accepted
Date: 2026-09-04

Amends ADR-0022 (see "Amends" below).

## Context

Harmonic drives a **closed set of three** Harnesses over ACP (Claude, Codex,
Copilot), each behind a code Adapter (CONTEXT.md "Harness"; ADR-0022 §9). We
want a fourth: **OpenCode** (`opencode`, v1.18.28), which speaks ACP over stdio
like the others. Two things make it different from the existing three:

- **No unattended full-access mode.** The three run unattended because Harmonic
  flips each into a permission mode where the agent never asks
  (`session/set_mode` → Codex `agent-full-access`, Copilot `auto`). OpenCode
  advertises only `build`/`plan` modes (via a non-standard `configOptions`
  array, not ACP's `modes`); `build` still emits `session/request_permission`
  for tool actions. And the Runner treats a permission request on an
  autonomous turn as a **hard stop** ("no human on this turn") — so an
  unattended OpenCode Task would die on its first edit.

- **A ~450-model, multi-provider router.** OpenCode routes to models addressed
  `provider/model` across many providers (only the credentialed ones are
  usable). A fixed, hand-curated `models[]` catalog (ADR-0022 §3) cannot
  reasonably enumerate that, and the operator has no way to *discover* what a
  Harness can actually route to at runtime.

## Decision

### 1. OpenCode is the fourth Harness

`opencode` joins `HARNESS_IDS`; the set stays **defined in code** (a new
Adapter `src/execution/harness/opencode.ts`), so ADR-0022 §9's rule — operators
tune config but cannot *add* a Harness — is unchanged. The "closed set of
three" becomes a **closed set of four**.

- Spawn: `command: opencode`, `args: [acp, --auto]`.
- Model pin via `session/set_model` after `session/new` (like Copilot's
  `sessionModelId`), ids of the form `provider/model`.
- Harmonic's MCP is injected over ACP `http` (OpenCode advertises
  `mcpCapabilities.http`).
- `commandPrefix: '/'`; `transcript: null` (rely on ACP `session/update`, the
  Copilot precedent).

### 2. Unattended access via `--auto`, not a permission mode

OpenCode has no full-access ACP mode to flip into, so unattended access comes
from the **CLI flag `--auto`** (allow-all-except-explicitly-denied → the agent
never emits `session/request_permission`). This is a **per-spawn** lever on the
process Harmonic spawns, not an edit to the operator's global
`~/.config/opencode/opencode.jsonc`, and not a change to the Runner's
"permission request on an autonomous turn is a hard stop" rule. The effective
posture — a Harness running unattended with full access and no prompts — is
**identical** to how Codex/Copilot already run; only the mechanism differs
(flag vs. ACP mode).

### 3. Harness capabilities: an optional Adapter extension point

The Adapter gains an **optional** `capabilities` surface for abilities beyond
the base contract. The first two are **dynamic discovery**:

- **`select_provider`** → the **available** providers a Harness can route to
  (available = credentialed, plus any always-on free tier), each
  `{ id, label, authed }`.
- **`select_model`** → the models available under a given provider, each
  `{ id, label, price?, contextWindow? }`.

Only OpenCode declares them; Claude/Codex/Copilot leave `capabilities` absent
and are unaffected. Two server routes expose them
(`GET /api/harnesses/:id/providers`, `GET /api/harnesses/:id/models?provider=`).

### 4. Discovery reads local metadata; no inference, no required ACP session

OpenCode's discovery implementation reads two on-disk files —
`~/.cache/opencode/models.json` (the models.dev cache: providers → models with
`cost` and `limit.context`) and `~/.local/share/opencode/auth.json`
(credentialed providers) — so discovery costs **no model inference** and needs
**no live ACP session**. (Spawning an ACP session to enumerate is an acceptable
fallback should the cache ever be unavailable — it likewise runs no inference —
but is not the primary path.)

### 5. Discovery lives in the launcher; picks are per-run and auto-priced

The provider→model picker lives in the **Task/Conversation launcher** only: an
operator picks any discovered model for a single run, **without** editing the
stored catalog. The static baseline `models[]` stays the curated headline list
(§6); discovery is the escape hatch to everything else. A dynamically-picked
model is **priced from the cache** at cost time; a model that genuinely lacks
cost data falls back to the existing `incomplete` flagging (ADR-0022 §3,
ADR-0008) — never a fake zero.

### 6. Baseline catalog: a curated, priced headline list

OpenCode's `baseline.yaml` block ships a short curated `models[]` — the
affordable default **`meta/muse-spark-1.3-contributor`** plus an Anthropic and
an OpenAI headline via OpenRouter — priced from the cache, not the full ~450.
`defaults.harness` and `chat.harness` stay `claude`; OpenCode is purely
additive.

### 7. Native Usage via OpenCode's SQLite store

OpenCode's Usage Collector reads its native store `~/.local/share/opencode/
opencode.db` (SQLite) for the per-model token breakdown, the same shape as
Copilot's `session-store.db` collector (CONTEXT.md "Usage Collector"). Each
Harness still has exactly one Collector.

## Consequences

- The "set of three" becomes four across code, config, UI enums, and CONTEXT.md;
  ADR-0022 §9's *decision* (operators cannot add a Harness; the set is defined
  in code) is untouched.
- Harnesses gain a first, optional extension point (`capabilities`); the base
  Adapter contract is unchanged for the three that do not declare it.
- The launcher can offer live provider/model discovery for a routing Harness
  without bloating the stored catalog; picks price themselves from local
  metadata.
- A new Usage Collector reads a SQLite store (Copilot's `node:sqlite` pattern,
  a bounded `WHERE session_id = ?` read).
- No code ships with this ADR; it records the decided shape. Delivery is the
  epic and its child tickets.

## Amends

Amends **ADR-0022** (which otherwise stands, `accepted`):

1. §9 "**The harness set stays fixed** … each of the three (`claude`, `codex`,
   `copilot`)" → a **fourth** in-code Harness, `opencode`. The rule that
   operators cannot add a Harness and the set is defined in code is unchanged;
   only the count (three → four) moves.
2. §3 the per-harness **Model catalog** is extended by an optional **dynamic
   discovery** capability (§3–§5 here): the catalog stays the source of the
   curated, priced baseline, and discovery is an additive, launcher-only escape
   hatch for a routing Harness — it does not change how the catalog resolves,
   merges, or prices.
