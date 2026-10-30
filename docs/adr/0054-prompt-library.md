# Decision: The Prompt Library replaces Prompt Fragments and Prompt Anatomy

Status: accepted
Date: 2026-10-30

Prompts become entries in a **Prompt Library**: named prompts, each with a
code and a description. A Task Execution Workflow step (ADR-0053) uses a prompt
by its code or as literal text, and a prompt can include another by code. The
order in which prompt text is put together moves out of code and into the
workflow's steps. Supersedes ADR-0047 and ADR-0050.

## Context

ADR-0047 made every assembled piece of prompt text an editable Prompt Fragment,
and ADR-0050 declared, in `src/domain/prompt-anatomy.ts`, which Fragments and
templates make up each kind of Resolved Prompt and in what order. Both assume
Harmonic owns the process and the operator edits text inside fixed slots. With
Task Execution Workflows the operator owns the process: which agent turns and
Critics run, and with what prompt. A fixed anatomy per prompt kind no longer
matches a process the operator writes, and a Fragment can only appear where
the anatomy put it.

## Decision

- **A Prompt Library of named prompts.** Each entry has a code and a
  description of what it is for.
- **A step uses a prompt by code or by literal text** written into the step.
- **Prompts include prompts.** A prompt includes another by code,
  `${{ prompts.code }}`, so shared text is defined once.
- **Bundled prompts are read-only.** They ship with Harmonic; Duplicate makes
  an editable copy, as for bundled workflows (ADR-0053).
- **Prompt Fragments and Prompt Anatomy are removed.** The ordering in
  `src/domain/prompt-anatomy.ts` moves into workflow steps: a step states its
  whole prompt.
- **One exception: the Critic's JSON verdict contract.** The engine parses the
  Critic's reply, so the engine appends the contract. It is not a Prompt
  Library entry and is not editable.
- **Critics are not a separate library.** A critic step names its prompt the
  same way as any agent step.
- **Resolved Prompts stay visible.** ADR-0047's rules carry forward unchanged:
  every Resolved Prompt sent to a Session is archived and shown at its point in
  the transcript, read from the Archive (ADR-0044), and editing a prompt affects
  the next execution, never one already sent. The Route Classifier's
  instructions (ADR-0052) become a Prompt Library entry under the same rule.

## Considered Options

- **Keep Prompt Fragments and Prompt Anatomy, and let steps reference prompt
  kinds.** Rejected: the anatomy fixes order and inclusion in code, which is
  exactly what a Task Execution Workflow hands to the operator.
- **Keep the verdict contract editable behind a marker gate** (ADR-0047 §2).
  Rejected: the contract is the parser's interface, not prompt wording.
  Appending it from the engine removes a class of bad saves.

## Consequences

- The Settings Prompts tab generated from the anatomy (ADR-0050), its compiled
  preview and its drift and coverage tests go away; the Prompt Library editor
  replaces them.
- Edited Fragments become Prompt Library entries during migration (ADR-0055).
- ADR-0047's amendment to ADR-0003, which made the restraint and the verdict
  contract editable, is partly reversed: the verdict contract is
  engine-appended again. ADR-0003's malformed-output → `inconclusive` backstop
  stays.
- Includes make a prompt's sent text differ from what its entry shows; the
  Resolved Prompt in the transcript remains the record of what was sent.

## Open questions

- Whether an include cycle is refused at save or at resolution.
- Whether the Critic's read-only restraint becomes a bundled Prompt Library
  entry or stays engine-appended with the verdict contract.
- Whether a Workspace or a Ticket can override a prompt's text, or only choose
  a different prompt through its workflow.

## Supersedes

ADR-0047 and ADR-0050. ADR-0047's visibility rule (Resolved Prompts archived,
shown in the transcript, read from the Archive, editing never rewrites
history) is restated above and remains in force.
