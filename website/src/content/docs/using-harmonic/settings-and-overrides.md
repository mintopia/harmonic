---
title: Settings & overrides
description: How Harmonic's global, workspace, and Task settings resolve, plus the Machine Ceiling, Permission Rules, and prices.
---

Harmonic settings live in three scopes with a single resolution rule
threaded through them: a **Workspace** or **Task** stores `null` to mean
*inherit*, and a non-null value overrides the inherited default. Every
overridable field is resolved **at read time**, never baked in ahead of
time.

## The three scopes

Per [ADR 0012](/harmonic/how-it-works/design-decisions/), every setting
falls into exactly one of three scopes:

| Scope | Settings | Where it lives |
| ----- | -------- | --------------- |
| Global-only (machine-level) | Harnesses, prices, notifications, Permission Rules, security, the Drive Prompt, the Machine Ceiling | Global settings page |
| Workspace-only (identity/state) | Name, Working Directory, tracker enable/interval, Auto-Runner enable, delete | Per-workspace settings page |
| Global-default with per-workspace override | Task defaults — harness, model, Isolation Mode, Priority — and the Auto-Runner concurrency cap | Both |

## Resolution

An overridable setting stores `null` on a **Workspace** to mean *inherit*;
a non-null value overrides the global default. The effective value is
resolved at read time as `workspace value ?? global default`.

Task defaults resolve one level further. The four Task-default columns
(harness, model, Isolation Mode, Priority) are themselves nullable on a
**Task** and resolve `Task ?? Workspace ?? global` on every read. This
produces a few consequences:

- A Task that never pinned a default follows its Workspace/global default
  as it changes, so retargeting a whole board's model is a single
  Workspace-setting edit — while a pinned Task stays put.
- A **mirrored** Task pins nothing, so a tracker-fed board retargets
  wholesale when the default changes; a **native** Task pins only what the
  operator explicitly set in the task form.
- A Task is editable while blocked, for exactly this reason: an operator
  can re-point a waiting Task's model before it ever runs.
- A **Run** reads its Task's *resolved* values at the moment it spawns, so
  a later settings change never rewrites that Run's history.

### The two surfaces

- The **global settings page**, opened from a header icon, holds the
  machine-level settings and the global defaults.
- The **per-workspace settings page**, a left-rail nav item scoped to the
  selected Workspace, shows each overridable field with its inherited
  value and an explicit override toggle. "Reset to default" clears the
  override — it sets the field back to `null`.

## Machine Ceiling

The global `maxConcurrentRuns` is the **Machine Ceiling**: the cap on
total concurrent Runs across all Workspaces. A per-Workspace concurrency
cap is one of the overridable settings, but it can never breach the
ceiling — a Workspace override is clamped to it. Total concurrency across
all Workspaces still cannot exceed the Machine Ceiling.

Auto-Runner *enable* is separate from the concurrency cap: it's a
per-Workspace toggle gated by a global **master switch** in the header. A
Task runs only if `master ∧ workspace-enabled`. The header switch is the
one-click fleet-wide pause.

## Permission Rules

Per [ADR 0007](/harmonic/how-it-works/design-decisions/), a **Permission
Rule** is a persistent, opt-in tier that auto-answers a Harness's
permission request when the tool **kind** and **Working Directory** both
match. A rule applies across the Conversation it was created in and any
newly-created Conversations.

| Tool kind | Meaning |
| --------- | ------- |
| `read`    | Reading a file or resource. |
| `edit`    | Modifying a file or resource. |
| `execute` | Running a command. |
| `fetch`   | Making a network request. |

A rule matches on `(kind, workingDir)`. Creating a rule is idempotent — a
rule for the same kind and directory is reused, not duplicated. Rules are
operator-visible and deletable from the global settings page.

## Prices

The **prices** table drives **Cost**, the dollar value of Usage. Config
`prices` entries override or extend the shipped default price table
(`DEFAULT_PRICES`), keyed by model id. Each entry — a **ModelPrice** — has
four rates in **$/Mtok**: `input`, `output`, `cacheRead`, and
`cacheWrite`. Harmonic ships default prices for the models the supported
harnesses use (Claude, OpenAI/Codex, and Copilot-served models).

A model with no price entry contributes `null` to Cost and flags the
aggregate **incomplete** — a partial total is a floor, never a fake zero.

Example — pricing a model Harmonic ships no default for (here a
self-hosted id), so its Runs stop counting toward the *incomplete* flag:

```json
{
  "prices": {
    "my-local-model": { "input": 0.5, "output": 1.5, "cacheRead": 0.05, "cacheWrite": 0 }
  }
}
```

## Drive Prompt

The **Drive Prompt** is a global template — there is no per-Task override
— used to auto-run afk mirrored Tasks. Its mechanics are covered on the
[Tracker mirroring & skills](/harmonic/how-it-works/tracker-mirroring/)
page.

## See also

- [Notifications](/harmonic/using-harmonic/notifications/)
- [Tracker mirroring & skills](/harmonic/how-it-works/tracker-mirroring/)
- [Design decisions](/harmonic/how-it-works/design-decisions/)
