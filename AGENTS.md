# AgentDeck

A web application running inside a Coder workspace that executes autonomous
agent Tasks by driving agent Harnesses (Claude, Codex, Copilot) over ACP.
See `CONTEXT.md` for the domain glossary.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
