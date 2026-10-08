# Decision: The Prompts tab is organised by Prompt Anatomy

Status: accepted
Date: 2026-10-08

The Settings Prompts tab is generated from one declaration of each Resolved
Prompt kind, its **Prompt Anatomy**, instead of a hand-ordered list of
textareas. Amends ADR-0047 (where Prompt Fragments are edited and previewed)
and ADR-0011 (the Settings tab layout).

## Context

ADR-0047 made every Prompt Fragment and prompt template editable. The Prompts
tab grew to 31 textareas in declaration order, plus four prompts on the
Verification tab. An operator could not see which Fragment ends up in which
Resolved Prompt, in what order, or under what condition. Each textarea also
carried its own preview, assembled by separate preview code that could drift
from the runtime.

## Decision

- `src/domain/prompt-anatomy.ts` is the single declaration of each Resolved
  Prompt kind: its Prompt Templates and Prompt Fragments in send order, the
  `oneOf` groups, the inclusion conditions, and nested slots and references.
  The Prompts tab, its counts, search and the compiled preview are generated
  from it.
- All runtime prompt joining lives in pure functions in
  `src/execution/prompt-assembly.ts`. The compiled preview calls the same
  functions with sample values. A marker-based drift test fails when the
  anatomy and the assembly disagree on order, condition or coverage. A new
  Fragment or template must be placed in an anatomy; a coverage test enforces it.
- The Epic verification fix prompt moves from the Verification tab to the
  Prompts tab (still global only). Per-critic prompts stay on the Verification
  tab, where critics are list items (ADR-0031, ADR-0037), and the Prompts tab
  links to them.
- Merge fate and Continue attempts move from the Prompts tab to an
  "Unattended drive" section on the Execution tab. They are behaviour, not
  prompt text.
- The Prompts tab is one bare section; layout responds to the panel width
  (container query), not the viewport.

## Consequences

- Each new conditional part needs an anatomy flag and a preview-assembler
  branch.
- Text added outside `prompt-assembly.ts` escapes the drift test.
- ADR-0047's glue rule holds: structural glue is not a Fragment and shows as
  "Built in" in the preview.
- Non-goals: URL deep links into a part, and the runtime reading its order from
  the anatomy.

## Supersedes

None. Amends ADR-0047 and ADR-0011.
