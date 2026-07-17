# Harmonic

A web application running inside a Coder workspace that executes autonomous
agent Tasks by driving agent Harnesses (Claude, Codex, Copilot) over ACP.
See `CONTEXT.md` for the domain glossary.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (mintopia/harmonic), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Design context

Strategic design context (register, users, personality, anti-references, design
principles) lives in `PRODUCT.md`. The visual system spec is `DESIGN.md` — it
describes **"Aurora"**, the system the UI actually ships (chosen and merged
2026-07-16), so read it as current and binding, not aspirational. Read both
before any frontend work.

(This note used to say DESIGN.md described a "terminal-native redesign target,
not the shipped zinc + amber UI". Both halves went stale two design iterations
ago — terminal-native "Signal Console" was dropped for Aurora, and zinc + amber
is long gone. Telling readers to distrust the spec is worse than saying nothing:
if DESIGN.md and the code ever disagree again, that is a bug in one of them to
be reconciled and written down, not a standing caveat to route around.)
