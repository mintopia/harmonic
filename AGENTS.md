# Harmonic

A web application running inside a Coder workspace that executes autonomous
agent Tasks by driving agent Harnesses (Claude, Codex, Copilot) over ACP.
See `GLOSSARY.md` for the domain glossary.

<!-- shared-rules:start (source: mintopia/home AGENTS.md; edit there, then copy) -->
## Shared rules

### Talking to me
- Be extremely concise; sacrifice grammar for concision.
- British English in prose, docs, UI copy and commits; identifiers follow the language's convention. No em dashes.
- Plain industry-standard terms.

### Working
- Finish the task. Own problems found on the way, including pre-existing failures.
- Fix root causes.
- Prove it works against the real artifact (run it, read the value, inspect the diff) before saying done.
- Match UI to its mockup exactly; raise a wrong or missing mockup on the ticket.
- Type-system discipline: illegal states unrepresentable, parse at boundaries, exhaust variants, derive types from the authoritative schema.
- Model the domain in data structures, not scattered conditionals.
- Make operations idempotent across partial runs, crashes and retries.

### Quality gate
- Red/green TDD for new behaviour and bug fixes.
- Before commit: formatter, linter, static analysis and tests pass at the repo's level. The repo's AGENTS.md names commands and any coverage bar.
- Comments: non-obvious why only, one or two lines. Run /comment-check before finishing.

### Subagents
- Delegate to subagents; run parallel teams that coordinate by messaging.
- Set model and subagent type explicitly:
  - Planning, reasoning, deep debugging: Opus / Sol
  - Explore, coding, review: Sonnet / Terra
  - Trivial edits, docs: Haiku / Luna
- Long results go to a scratchpad file; return one line plus the path.

### Git
- Work on the branch you started on; parallel work goes in a worktree off it.
- Rebase only onto your own base branch.
- Delete merged or abandoned branches and worktrees, locally and on the remote.

### Decisions


Before proposing architecture, tooling, style, testing, repo structure, or workflow changes in any project:

1. Check for a `docs/decisions/` directory in the project root.
2. If it exists, search it for relevant ADRs (Architecture Decision Records).
3. Treat accepted ADRs as binding unless explicitly overridden by the user.
4. If a decision is outdated, propose a new ADR that supersedes it rather than silently ignoring.
5. Do not re-litigate accepted decisions unless new constraints are introduced.

When creating new ADRs, use this format:

```markdown
# Decision: [Title]

Status: [proposed|accepted|deprecated|superseded]
Date: [YYYY-MM-DD]

## Context
[Why this decision is needed]

## Decision
[What was decided]

## Consequences
[Trade-offs and implications]

## Supersedes
[Reference to previous ADR, or "None"]
```

### Code exploration

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

<!-- shared-rules:end -->

## Repo rules

### Testing

While editing, run the relevant test file with `npx vitest run <file>`.
Before the final test run, run `npm run typecheck` and `npm run lint`.
If you changed a route or its zod schema, run `npm run docs:openapi` and commit
the regenerated `website/src/openapi.json` — CI fails if the snapshot drifts.
Run `npm test` once when the work is complete. It starts ACP harnesses and
covers shared-lock integration cases, so it is slower than a focused test.

When running tests, run them sequentially, not in parallel. Running them in
parallel risks killing the server running the tests.

Run the full suite only when work is completed. If tests fail, fix the issue
and re-run just those tests.

### Stopping servers you started

A live Harmonic instance on this host runs your Task, so any server you start
shares a process table with it. Stop a server only by the PID you captured when
you started it (`node dist/cli.js serve … & echo $! > "$D/pid"`, then
`kill "$(cat "$D/pid")"`). Never use `pkill -f`, `killall`, or a
`pgrep -f "cli.js serve"` loop: those patterns match the live instance and
kill every running Attempt.

### Branching and rebasing

The integration line is `develop` and the
`epic/*` branches; `main` is the stale release branch (`origin/main`,
`origin/HEAD`, and `v1.0.0` all sit on the tagged release, far behind develop).

Never `git rebase origin/main` (or `origin`/`origin/HEAD`) — that replays your
work onto the release tip and drags in a mountain of divergence. If you must
rebase, rebase onto your task's own base branch (the `develop` or `epic/*` ref
you started from), never the release line.

Never work directly in develop. If you would work directly in develop, create a
worktree and then merge when done.

### Releases

release-please cuts releases from `main`; `develop` promotes to `main` by a
merge PR. Before cutting a release, bumping a version, or pushing a tag, see
`docs/agents/release.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (mintopia/harmonic), via the `gh` CLI. See `docs/agents/issue-tracker.md`.
All tickets created as part of an epic must all have the parent properly assigned
and any blocking relationships configured in GitHub.
If possible, all tickets should have a defined method to verify the work - for example:
 - Mock/screenshot comprison
 - User stories that map to test cases that must be written

### Triage labels

Default vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

The ADR-0001 implementation epic is complete. `docs/adr/README.md` indexes
current decisions and their amendments; later ADRs take precedence only for
the clauses they explicitly replace. Pre-reset ADR numbers refer to the set
archived at `adr-reset-2026-08-28`, not same-numbered current documents.
Check the current decision and its amendments before treating old terminology
or a historical review finding as unfinished work.

### Design context

Before frontend work, read `PRODUCT.md` for users, product behavior, and design
principles, and `DESIGN.md` for the current **Paper** visual system. The CSS
tokens in `web/src/index.css` define its palette. Reconcile disagreements
between the design documentation and shipped UI rather than treating the spec
as aspirational. Execution behavior follows the current ADRs.

## Coding conventions

### Background loops must yield

Harmonic runs every HTTP handler and every background loop on one Node event
loop. Any background loop that iterates a collection whose size grows with the
database or the workload MUST chunk its synchronous work and yield the loop
between chunks, so it can never freeze the process (issue #200, ADR-0007).
This covers the boot sweep, periodic polls, reconcile passes, and the Auto-Runner
fill. Use `forEachYielding` / `yieldToEventLoop` from `src/reliability/yield.ts`.
This is distinct from bounding retries/subprocess spawns (#219) and routing heavy
aggregate reads off the loop (#213).
