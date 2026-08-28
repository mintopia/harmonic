# Harmonic

A web application running inside a Coder workspace that executes autonomous
agent Tasks by driving agent Harnesses (Claude, Codex, Copilot) over ACP.
See `CONTEXT.md` for the domain glossary.

## House rules

Use subagents for tasks.
Use multiple subagents in parallel working as a team, with agent messaging to co-ordinate.
Subagents must use an appropriate model, defaults:

 - Explore, Coding, Code Reviews: Sonnet / Terra
 - Codebase Mapping: jcodemunch MCP and Sonnet / Terra
 - Reasoning and Planning: Opus / Sol
 - Trivial, Documentation: Haiku / Luna

Explicitly specify the model when starting a subagent.
Subagents must use an appropriate subagent type.
Do not start a subagent without explicitly setting the model.

### Testing

While editing, run the relevant test file with `npx vitest run <file>`.
Before the final test run, run `npm run typecheck` and `npm run lint`.
Run `npm test` once when the work is complete. It starts ACP harnesses and
covers shared-lock integration cases, so it is slower than a focused test.

### Branching and rebasing

Work only on the branch you start on. The integration line is `develop` and the
`epic/*` branches; `main` is the stale release branch (`origin/main`,
`origin/HEAD`, and `v1.0.0` all sit on the tagged release, far behind develop).

Never `git rebase origin/main` (or `origin`/`origin/HEAD`) — that replays your
work onto the release tip and drags in a mountain of divergence. If you must
rebase, rebase onto your task's own base branch (the `develop` or `epic/*` ref
you started from), never the release line.

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

## Coding conventions

### Background loops must yield

Harmonic runs every HTTP handler and every background loop on one Node event
loop. Any background loop that iterates a collection whose size grows with the
database or the workload MUST chunk its synchronous work and yield the loop
between chunks, so it can never freeze the process (issue #200, ADR-0029 §5).
This covers the boot sweep, periodic polls, reconcile passes, and the Auto-Runner
fill. Use `forEachYielding` / `yieldToEventLoop` from `src/reliability/yield.ts`.
This is distinct from bounding retries/subprocess spawns (#219) and routing heavy
aggregate reads off the loop (#213).

## Code exploration policy

Always use jCodeMunch-MCP for code navigation. Never fall back to Read, Grep, Glob, or Bash for code exploration.
**Exception:** use `Read` when you are about to edit a file — the harness requires a `Read` before `Edit`/`Write`. Use jCodeMunch to *find and understand* code, then `Read` only the file you are changing.

This server runs the **front door** surface: three tools reach every jCodeMunch capability, so the tool list stays small and the catalogue is fetched only when you need it.

**Start any session:**
1. `order { "action": "resolve_repo", "args": { "path": "." } }` — confirm the project is indexed. If it is not: `order { "action": "index_folder", "args": { "path": "." } }`

**Then, for any task:**
- Know what you want → `order { "action": "<name>", "args": { ... } }`
- Know the goal, not the tool → `route { "query": "your task in a sentence" }` picks the action and shapes the arguments
- Want to see what exists → `menu { "query": "what you are trying to do" }` returns matching actions with example arguments
- Want the whole catalogue and the usage rules → `jcodemunch_guide`

`menu` and `jcodemunch_guide` list every action this server can run, including ones absent from your tool list. That is expected: the front door is the way to call them.

**Interpreting results:**
- A `verdict` of `no_implementation_found` is evidence of absence. Report the gap; do not re-search with different wording.
- A `verdict` of `degraded` means a channel was unavailable, so absence is NOT proven. Read the note before relying on the result.
- `source: ""` alongside `source_status` means the body could not be read, not that the symbol is empty.

**After editing files:**
- With PostToolUse hooks installed (Claude Code), edited files are reindexed automatically.
- Otherwise `order { "action": "register_edit", "args": { "paths": [...] } }` after an edit, batched for bulk changes.

**Announce your model once per session** so the server can size its answers: `announce_model { "model": "<your-model-id>" }`.
