# Decision: Prompt Fragments are operator-editable and every Resolved Prompt is visible

Status: accepted
Date: 2026-10-05

Every piece of text Harmonic assembles into a prompt is an operator-editable
**Prompt Fragment** (a setting, not a hardcoded string), and every **Resolved
Prompt** actually sent to any Session is archived and surfaced in the transcript
views. This removes the opacity where assembled fragments — the critic's
read-only restraint, the revision block, the JSON verdict contract, the
main-Attempt self-heal and code-index blocks, the continue/commit nudges —
were baked into code, invisible to the operator, and unchangeable.

## Context

ADR-0003 has Harmonic *append* a read-only restraint instruction and a strict
JSON verdict contract to the operator's critic prompt, and settles that
malformed critic output is `inconclusive` (which burns an Attempt). Those
appended parts, and the equivalent inline fragments on other prompts, lived as
string literals in code — so the Settings prompt editors governed only the
operator template, and an operator could neither read nor change the rest. The
Resolved Prompt was shown for the latest task critic and the first Attempt turn
only; later turns, nudges, the epic resolver, and merge-conflict resolvers were
either archive-only or not persisted at all.

## Decision

1. **Fragments become settings.** Every assembled fragment is promoted into the
   configuration system as a Prompt Fragment, with a `baseline.yaml` default and
   per-Workspace override, edited on the existing Prompts tab (ADR-0022, ADR-0009
   — inheritance, modified marker, and per-field revert come for free). A
   fragment shared across prompts (the read-only restraint) is defined once and
   referenced, not copied. Pure structural glue — concatenation order and
   whitespace — stays in code.

2. **The verdict contract stays safe.** The JSON verdict contract is editable
   but gated: a save is rejected unless the text still contains the contract
   markers the verdict parser needs. ADR-0003's "malformed output →
   `inconclusive`" remains the runtime backstop, so the verdict guarantee holds
   even if a bad contract slips through. The read-only restraint is, as ADR-0003
   already accepts, a soft control by prompt instruction; editing its wording
   loosens no enforcement that ever existed.

3. **Editing is config, not a rerun.** Editing a prompt changes the configured
   template/fragment and takes effect on the *next* execution of a waiting or
   future Attempt. It never rewrites history: a Resolved Prompt already sent is
   immutable, and there is no in-place "rerun this attempt with a new prompt".

4. **The visibility rule.** Every Resolved Prompt is written to the Archive and
   shown inline at its point in the transcript — the turn, nudge, critic run, or
   conflict resolution that sent it. This extends to surfaces that were
   archive-only or unpersisted (later Attempt turns, continue/commit nudges, the
   epic resolver, merge-conflict resolvers): anything Harmonic sends is archived
   and surfaceable, or it is a bug. The transcript shows the Resolved blob as it
   was sent, unannotated; the structured, labelled fragment breakdown lives in
   the Settings compiled preview, where editing happens.

5. **Reads come from the Archive.** The transcript reads Resolved Prompts from
   the Archive on demand (ADR-0044: the Archive holds every resolved prompt sent
   to any Session; the DB owns no transcript), off the event loop (ADR-0007).
   Resolved Prompts are not duplicated into the database.

## Supersedes

Amends ADR-0003 for two clauses only: the appended restraint instruction and the
appended JSON verdict contract are now operator-editable Prompt Fragments rather
than Harmonic-owned string literals. ADR-0003's verdict-attaches-to-Attempt rule,
its in-place doctrine, and its `inconclusive`-burns-an-Attempt rule stand
unchanged, and the malformed-output backstop is what keeps the editable contract
safe. Also discharges ADR-0022 §2 ("no magic strings") for prompt text.

## Consequences

- The Settings Prompts surface grows a fragment per promoted piece; shared
  fragments keep that count down and prevent drift.
- An operator can now author a Resolved Prompt that produces worse reviews. The
  verdict-contract gate and the `inconclusive` backstop bound only the parsing
  failure mode, not prompt quality — reset-to-default is the escape hatch.
- Filling the archive gaps is a prerequisite, not a nicety: the visibility rule
  is only true once every assembly site appends its Resolved Prompt to the
  Archive.
