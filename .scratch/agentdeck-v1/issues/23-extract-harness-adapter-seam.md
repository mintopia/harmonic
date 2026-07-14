# Refactor: extract the Harness Adapter seam

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

A pure behavior-preserving refactor: move the Claude-specific knowledge
currently smeared across generic code into a per-harness adapter module
behind a small interface, so Codex (issue 24) and Copilot (issue 26) become
purely additive.

The adapter interface, keyed by `HarnessId`, covers exactly two concerns:

- **Spawn tweaks**: env/args the harness needs per run — model pinning and
  quirk workarounds. Today's Claude-isms move here from `runner.ts`:
  the `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` stripping and the
  `ANTHROPIC_MODEL` variable (`AGENTDECK_MODEL` stays generic).
- **Usage Collector** (see CONTEXT.md): the per-harness Usage source.
  Today's Claude-isms move here from `usage.ts`: the default session-log
  dir (`~/.claude/projects`), the cwd-slug + sessionId path convention,
  the JSONL assistant-message parser, and the `_meta.claudeCode.toolName`
  tool-tally preference.

Operator config keeps only what is genuinely operator-tunable (`command`,
`args`, `env`, `models`, `defaultModel`, `sessionLogDir`); harness facts
live in code, versioned with the parser that shares their assumptions
(decision Q3 of the planning session, 2026-07-14).

Codex and Copilot get stub adapters (no spawn tweaks beyond
`AGENTDECK_MODEL`, no Usage Collector) so behavior is exactly today's.

## Acceptance criteria

- [x] `runner.ts` and `usage.ts` contain no `claude`-conditional logic; the Claude adapter owns it
- [x] Existing tests pass unchanged (or with mechanical import updates only) — no behavior change for Claude runs, including `collectUsageWithRetry` and `backfillUsage` paths
- [x] Adding a new harness's spawn tweaks or Usage Collector requires touching only its adapter module and the adapter registry

## Blocked by

None — needs no spike findings; can run in parallel with issue 22.

## Comments

2026-07-14 (agent): Done in commit "Issue 23: extract the Harness Adapter seam".
New `src/execution/harness/` (adapter.ts interface + registry, claude.ts,
codex.ts, copilot.ts stubs). runner.ts and usage.ts are harness-agnostic;
full suite green (100 tests) with no behavioral test edits.
