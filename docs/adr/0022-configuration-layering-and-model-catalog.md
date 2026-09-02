# Decision: Configuration layering, modified state, and the per-harness model catalog

Status: accepted
Date: 2026-09-02

Amends ADR-0009 (see "Amends" below). This is the "separate planned config
track" ADR-0021 deferred (0021, "Shipped config default values and the
settings-surface trim").

## Context

ADR-0009 made `settings.yaml` in the data directory the **sole** home of
configuration, "no out-of-band seed", and persisted the global block
**fully merged** with the shipped defaults. Three problems fall out of that:

- **No global revert.** The shipped defaults live in `defaultConfig()` (code)
  and `pricing.ts` (the price and context-window tables) as literals. Because
  the persisted global block is flattened, nothing records *what the operator
  changed*, so there is no "modified vs shipped" signal and nothing to revert
  *to* at the global level. Workspaces already store a sparse override with a
  per-field reset; global does not.
- **Model metadata is split and can't be shown per model.** A model is a bare
  string in a harness's `models: string[]`; its price and context window live
  in a separate global-by-id map in `pricing.ts`, decoupled from the harness
  list. The harness/model settings UI can't show cost, context window, or cache
  window beside a model, and a single id cannot carry two prices — but Copilot
  prices some shared ids differently from Claude.
- **Changing a harness leaves a stale model.** The task/chat model is resolved
  against the currently-selected harness but the previously-picked value is
  neither cleared nor reset, which reads as a bug.

## Decision

### 1. Three layers: Baseline → Global → Workspace

Configuration resolves through three layers. The **Baseline** is the shipped
default; the **Global** (operator) layer is a **sparse patch** merged onto the
baseline; the **Workspace** layer is a sparse patch merged onto the resolved
global (unchanged from ADR-0009). A field the operator has not touched tracks
the baseline as the app ships new defaults.

- Resolved global = `merge(baseline, globalPatch)`.
- Resolved value = `workspacePatch ?? resolvedGlobal` at read time (the
  ADR-0009 read-time model is otherwise unchanged).
- The persisted global block becomes the **sparse patch**, not the flattened
  result — the same shape workspaces already use.

### 2. Baseline is a shipped `baseline.yaml`, in-repo

The baseline is extracted from `defaultConfig()` into a `baseline.yaml`
**shipped in the app bundle / repo** (distinct from the user-writable
`settings.yaml` in the data directory). It is parsed and validated against
`appConfigSchema` at boot, **failing loud** on an incomplete or invalid file
(the same discipline `settings-store.ts` already applies to `settings.yaml`).
`defaultConfig()` is **deleted** — the YAML is the single source of defaults.
"No more magic strings" means every default routes through it, including the
stray literals that bypass it today (the Copilot `'auto'` no-pin sentinel,
`web/src/prompt-preview-model.ts`, story fixtures).

### 3. Per-harness model catalog

A **Model** becomes a first-class per-harness catalog entry
`{ id, price, contextWindow }`. Each harness owns its `models[]` as entries,
not bare strings.

- `AppConfig.prices` and `AppConfig.modelInfo.contextWindow` **fold into** these
  entries. A shared id can be priced differently under different harnesses
  (Copilot), which a global-by-id table cannot represent.
- The catalog is **open**: a custom id typed in the UI becomes an entry with
  `null` price / context window, so its cost is flagged `incomplete` (the
  existing honest-numbers behaviour, never a fake zero). All entries — shipped
  or custom — are editable in the settings UI.
- `pricing.ts`'s resolve functions (dated-suffix stripping, `incomplete`
  flagging) stay in code but read the new `(harness, id)` shape; the literal
  tables move into `baseline.yaml`.

### 4. Cache window is a harness property

Each harness carries a single **`cacheWarmSeconds`**. The per-model
`modelInfo.cacheTtlSeconds` is **removed**. The warm-until *times* shown in the
UI are **derived** at runtime (`lastActiveAt + cacheWarmSeconds`), never stored
config — a different plan is one edit to the harness's number, not a schema
branch. This matches the Session concept's existing per-Harness warm-window
framing (CONTEXT.md).

### 5. Modified state and revert, unified across both boundaries

A field that inherits the layer beneath it renders **muted** (visually distinct
from disabled); using or replacing it renders it **unmuted with a modified
symbol and a revert control**. One visual language applies identically at both
boundaries — global-vs-baseline and workspace-vs-global — replacing ADR-0009's
"inherited from global" source text and the workspace `InheritField` reset
button. Revert is **per-field**, plus a top-level "revert all to distributed".

### 6. Collections keyed-merge on id

`models[]` (and the price / context overrides folded into it) is treated as
**keyed by `id`**: the operator patch is per-id — add an id, override one field
on a baseline id, or **tombstone** an id to remove it. New baseline models flow
in automatically (not tombstoned). The command verifier keeps its ADR-0009
list-grain whole-array override; `models[]` differs deliberately because its
entries carry stable ids and must keep tracking baseline additions.

### 7. Harness change resets the model to the new harness's default

Selecting a different harness drops the previous model and sets it to the new
harness's `defaultModel`. It never leaves a stale value and never produces an
unsaveable empty model (the model-required validation is unchanged).

### 8. Existing `settings.yaml` converts on load

On first load of a pre-existing flattened file, the global patch is derived as
`deep-diff(storedGlobal, baseline)` and the file is **rewritten sparse** — a
one-time, boot-time convergence, no migration script (the spirit of the
schema-sync "boot converges onto baseline" rule for the DB). Edge: a value the
operator set *equal* to a baseline value reads back as unmodified; this is
cosmetic (the modified badge only) and never changes the effective value.

### 9. The harness set stays fixed

Operators edit harness *config* (command, args, env, models, `cacheWarmSeconds`)
but cannot add a harness: each of the three (`claude`, `codex`, `copilot`)
needs a code adapter. The harness set stays defined in code.

## Consequences

- **Global revert and "kill magic strings" become the same mechanism**:
  dropping the patch falls back to the baseline that is now the one source of
  defaults.
- **Unmodified settings track the baseline** as the app ships new defaults —
  including new baseline models, via the keyed-merge (§6).
- `pricing.ts`'s literal tables move into `baseline.yaml`; the resolve helpers
  stay in code on the new shape.
- **A second YAML ships in-repo** (`baseline.yaml`), reversing ADR-0009's
  "no out-of-band seed"; that clause is amended here (below).
- CONTEXT.md gains the **Baseline** layer (Setting Override), a **Model**
  catalog entry, and the cache-window-on-harness clarification; the Session
  entry's warm-window framing is confirmed and names `cacheWarmSeconds`.
- No code ships with this ADR; it records the decided shape for the config
  track ADR-0021 deferred.

## Amends

Amends **ADR-0009** (which otherwise stands, `accepted`):

1. "**`settings.yaml` is the sole home of configuration; there is no
   out-of-band seed**" → a shipped `baseline.yaml` is now the seed; the global
   block in `settings.yaml` becomes a sparse patch over it (§1, §2).
2. "**Machine-level settings (harnesses, model prices, `modelInfo`) stay
   global**" as separate top-level keys → `prices` and
   `modelInfo.contextWindow` fold into per-harness model entries, and
   `modelInfo.cacheTtlSeconds` is replaced by harness `cacheWarmSeconds`
   (§3, §4).
3. "**source inline (On · inherited from global)**" display → the muted /
   modified / revert visual, extended to the third (baseline) layer (§5).
