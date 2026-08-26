# Decision: Settings resolve through one scope-declaring schema with universal three-state inheritance

Status: accepted
Date: 2026-08-26

## Context

ADR-0012 established per-workspace overrides with `null`-means-inherit and
read-time `workspace ?? global` resolution. In practice the implementation grew
two different override mechanisms that no longer agree, and the settings UI hides
what actually resolves.

**Two mechanisms.** Scalar settings (harness, model, isolation, priority, cap,
chat defaults) go through a clean, generalised path: `resolve<T>` in
`src/domain/setting-override.ts` and the `InheritField` / `inheritState` UI
state-machine. But the verifiers do not. The command verifier and the agent
critic carry a bespoke tri-state — inherit, an `{off:true}` sentinel, or an
override object — resolved by hand in `resolveVerifiers`/`resolveReview` and
seeded by hand in the UI. The critic override is a single *atomic* object
(`enabled` + `prompt` + `model` + `harness` stored together), matched through a
zod union whose member ordering is load-bearing.

**The atomic critic caused a real, invisible bug.** Because the permissive
`verificationReviewSchema` sat before the strict critic member in the union, a
workspace critic `{prompt, model}` was swallowed and coerced to `enabled:false`
on save. The override persisted as *disabled*, so the runner correctly skipped
it — and the operator, who had configured a critic, saw nothing run and no
explanation. This was fixed at commit `f6cad75` by reordering the union, but the
fix patched the symptom; the atomic object, the sentinel, and the ordering-
sensitive union remain, and the whole shape is more clever than a per-workspace
toggle should ever need to be.

**Parity is not guaranteed anywhere.** Global and per-workspace settings are two
hand-built React forms (`SettingsPage.tsx` ~658 L, `WorkspaceSettingsPage.tsx`
~759 L) that share chrome primitives but duplicate every field's wiring, and
re-implement Verification and Task/Chat-defaults independently. Whether a global
setting has a matching workspace override is a matter of remembering to add it on
both sides. Several do not: per ADR-0012, `drive.*`, `taskPrompt`, and
`guardrails.toolTimeoutMinutes` are global-only with no per-workspace override.

**The failure was invisible.** The specific cure the operator needed already
partly exists on the run/ticket side (ADR-0042 made a skipped/disabled verifier a
labelled state), but the *settings* surface still shows no resolved value, no
source, and no signal when an enabled verifier cannot actually run.

The resolution layer itself is sound (`workspace ?? global`, no cross-key global
gate). The problem is representation and surfacing: a bespoke verifier path that
diverges from the general one, compound overrides that couple independent
choices, parity by memory instead of by construction, and no visibility of what
resolves.

## Decision

**A. One scope-declaring schema is the single source of truth.** Every setting
declares, in one registry, its **scope** (`global-only` or `overridable`) and its
control (type, label, help). The resolver and *both* settings surfaces are
derived from that declaration. Parity becomes a property of construction: an
`overridable` setting exists on the workspace surface because the schema says so,
not because two forms were kept in sync by hand. "Full mirror" is the special
case where every setting is marked `overridable`.

**B. Universal three-state inheritance.** Every overridable setting is
inherit / on / off, with `null` = inherit, resolved centrally through the same
`resolve<T>` the scalars already use. An explicit workspace value wins over the
global default in *both* directions — workspace-on beats global-off, and
workspace-off beats global-on. There is no cross-key global master flag gating
another setting.

**C. Compound overrides decompose into independently-inheritable scalars.** The
agent critic stops being one atomic object override and becomes four
independently-inheritable fields — `reviewEnabled`, `reviewPrompt`,
`reviewModel`, `reviewHarness` — each resolving `workspace ?? global` on its own.
"Turn review on in this workspace" flips one boolean while prompt/model quietly
inherit. The `drive.*` block likewise decomposes into its constituent fields
(`prompt`, `unattendedReminder`, `continuePrompt`, `mergeFate`,
`continueAttempts`), each independently inheritable. The `{off:true}` sentinel is
deleted — "off" is just `enabled:false` — and the ordering-sensitive
`verificationCritic` compat union is removed. Existing workspace override rows are
migrated once to the scalar shape; no read-time compatibility shim is kept.

**D. The command verifier overrides at the list grain.** `verify.commands` is a
list, so it inherits as a whole, not field-by-field: **inherit** (`null` → use
the global command list), **override** (the workspace supplies its own full
array), or **off** (an explicit empty array — "run no commands in this
workspace"). There is no per-command inheritance. The workspace command control
becomes a full add/remove editor at parity with global, replacing today's
single-command collapse.

**E. Scope reclassification (amends ADR-0012).** `drive.*`, `taskPrompt`, and
`guardrails.toolTimeoutMinutes` move from global-only into the overridable set —
repos genuinely differ in merge policy, task framing, and tolerance for slow
tools. `conversationIdleTimeoutMinutes`, `harnesses`, `prices`, `modelInfo`, the
instance `name`, notifications, and security/permission rules stay global-only.
This narrowly amends ADR-0012's classification of the drive prompt as
global-only; the rest of ADR-0012 (Task→Workspace→global default resolution, the
Machine Ceiling, chat defaults) is unchanged.

**F. Validate the resolved config, and never silently skip.** The "enabled ⇒ has
prompt + model" invariant is judged on the *resolved* config, not on each raw
layer in isolation, and is checked on save against the current global. An
effectively-enabled-but-unrunnable verifier is a **loud, visible state** on the
settings surface (e.g. "Review: on — but no model resolved"), never a silent
no-op. The review contract is stated truthfully in the UI copy: commands run in
order and stop at the first failure; a single agent review runs once, after all
commands pass (gate-on-pass). This extends ADR-0042's run/ticket-side visibility
to the settings surface; it does not change how verification runs (ADR-0021) or
how critic transcripts are captured (ADR-0040).

**G. Both pages render from one schema-driven, tabbed engine.** A single form
engine renders global and workspace settings from the schema into a shared tab
taxonomy — **General**, **Execution**, **Verification**, **Prompts**,
**Integrations**, **Security**. The workspace surface is the same renderer with
the inherit layer enabled and `global-only` tabs hidden; a tab with a single
workspace-relevant field may collapse to a section. Each field shows its resolved
value and its source inline ("On · inherited from global" vs "Off · overridden
here") — good enough that no separate "effective configuration" dump is needed.
All config *values* flow through one buffered save bar (dirty → Save/Discard);
only genuine side-effect *actions* (e.g. "send test notification") stay
immediate. Global keeps its whole-config PUT and workspace its field PATCH
(`null` clears an override); the transport differs but the interaction is
identical. The redesign conforms to Paper (ADR-0034).

**H. Sequenced, one design.** Phase 1 lands the schema, the generalised resolver,
the row migration, and the correctness/validation behaviour first (the
load-bearing model). Phase 2 rebuilds the UI on the corrected foundation. Two
PRs, one epic.

## Consequences

- Parity is guaranteed by construction rather than by remembering to edit two
  forms; the ~1400 lines of duplicated field wiring across the two pages
  collapse into one schema-driven engine.
- The entire class of "which union member matches first" hazard is deleted, not
  just the one instance `f6cad75` fixed. Decomposition also removes the coupling
  that forced re-supplying prompt/model when enabling review.
- A one-time migration converts existing workspace override rows (atomic critic,
  `{off:true}`, bare critic; atomic `drive.*` if any) to the scalar columns;
  after it runs, the compat union and sentinel are removed with no read shim
  (consistent with this repo's no-backwards-compat-shim stance).
- ADR-0012 is narrowly amended (drive prompt / `taskPrompt` /
  `toolTimeoutMinutes` become overridable). The three-scope idea in 0012 is
  generalised into the scope-declaring schema; its other decisions stand.
- `resolveVerifiers`/`resolveReview` are consumed by the runner
  (`src/execution/runner.ts`), the tracker (`src/tracker/manager.ts`), and the
  epic path (`src/execution/epic-verification.ts`), and ADR-0042's derived
  verifier status reconciles against `resolveVerifiers()`. The resolver refactor
  must keep those callers green slice by slice and preserve 0042's
  passed/failed/skipped/disabled classification.
- New scalar override fields must be added to both the WS and REST zod schemas to
  keep parity (per the WS/REST parity tests); the generated `openapi.json` is
  left at HEAD and regenerated separately, not inside this change.
- Two settings surfaces still exist (global, workspace) but now describe the same
  schema from two angles; the shared taxonomy keeps them legibly the same thing
  minus the global-only tabs.
- The per-run "verification plan" surface (what a run will execute) is explicitly
  *out of scope* here — it is run-UI and ships as its own ticket.

## Supersedes

None. Builds on and **amends ADR-0012** (per-workspace setting overrides —
scope classification of the drive prompt and override representation of the
verifiers). Aligns with ADR-0042 (verification always visible), ADR-0034
(Paper), ADR-0021 (verification gate), and ADR-0040 (critic transcript locator).
