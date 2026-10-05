# Harmonic

Harmonic executes autonomous agent Tasks inside a Coder workspace by driving
agent Harnesses (Claude, Codex, Copilot) over ACP.

## Conventions

- Vocabulary: `GLOSSARY.md` is the authoritative glossary. Specs use its terms
  and avoid its `_Avoid_` lists.
- Decisions: `docs/adr/` holds the accepted ADRs; `docs/adr/README.md` indexes
  them. A change proposal cites the ADR it implements or amends.
- Layout: one change per directory under `openspec/changes/<change-id>/` with
  `proposal.md`, `design.md`, `tasks.md`, and delta specs under
  `specs/<capability>/spec.md`. Accepted capabilities are merged into
  `openspec/specs/<capability>/spec.md` when a change ships.
- Tracking: each change has a GitHub epic whose children are the tasks.
