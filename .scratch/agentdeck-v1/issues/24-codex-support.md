# Codex support

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Fill in the Codex Harness Adapter from issue 22's findings, to full parity
with Claude: Runs execute over ACP, stream events, hit the review gate, the
per-Task model is honored (and the observed model is surfaced if it ever
contradicts `task.model`), and Usage carries a per-model breakdown via the
rollout-log Usage Collector.

Scope, all shaped by spike findings:

- **Spawn tweaks**: the verified model-pinning mechanism; any quirk
  workarounds the spike surfaced. Correct `defaultConfig()` if the spike
  contradicts `codex acp` or the shipped model list.
- **Usage Collector**: parse Codex rollout logs into the per-model
  `ModelUsage` map, correlated from the ACP `sessionId`, with the same
  flush-race retry semantics Claude gets (`collectUsageWithRetry`,
  `backfillUsage`).
- **MCP registration**: pass AgentDeck's MCP server (URL + Run Key bearer
  header) via ACP `session/new` `mcpServers` if the spike verified support;
  env-var fallback otherwise.
- **Legible auth failure**: an unauthenticated spawn fails the Run with a
  recognizable reason (per the spike's captured failure shape), not a bare
  exit code.
- If the spike found the model not pinnable: collapse the Codex `models`
  list to its verified default and fix the Task form display (decision Q7
  — no dropdown that lies).

Cost needs no changes: Codex models already have `DEFAULT_PRICES` entries,
and Cost stays uniformly API-equivalent (decision Q4).

## Acceptance criteria

- [x] A real Codex Task runs end-to-end: ready → running → awaiting-review, with streamed session updates in the run detail
- [x] The Task's model demonstrably reaches Codex (verified per the spike's actual-model check), and a contradicting observed model is surfaced on the run
- [x] Usage on a finished Codex run has a per-model breakdown (source `combined`: ACP prompt result primary, rollout log as fallback — reworded per spike Q3), and Cost prices it with no incomplete flag
- [x] The spawned Codex agent can call AgentDeck's MCP tools using its Run Key with zero operator setup
- [x] An unauthenticated Codex spawn fails the Run with a legible reason
- [x] Tests cover the Codex Usage Collector against captured rollout-log fixtures from the spike

## Blocked by

- Issue 22 (spike findings)
- Issue 23 (adapter seam)

## Comments

2026-07-14 (agent): Done, with the spike's adjustments over the issue text:

- The Codex Usage Collector's *primary* source is the ACP prompt result
  (`_meta.quota.model_usage`) via a new optional
  `UsageCollector.modelsFromPromptResult` hook — the interface gap flagged
  in the issue-22/23 review. The rollout-log parser exists as the fallback
  (failed runs, `backfillUsage`), located by the sessionId embedded in the
  log filename; tested against the spike's captured excerpts. A clean run's
  source is `combined` (ACP totals + per-model split).
- MCP registration goes through a new `HarnessAdapter.mcpServers()` hook:
  codex gets the HTTP + bearer entry in `session/new`; claude/copilot keep
  the env-var mechanism.
- A contradicting observed model is recorded as a `model_mismatch`
  lifecycle event on the run (rendered in the run detail's stream). The
  check passes when *any* observed model matches the pin's base id, so
  harness helper-model spend doesn't false-positive.
- Default codex config now spawns `npx --yes @agentclientprotocol/codex-acp`
  with the verified model list (gpt-5.6-sol/terra/luna, 5.5, 5.4,
  5.4-mini; `model[effort]` accepted); `DEFAULT_PRICES` gained the
  published 2026-07 OpenAI rates for those ids. A new invariant test keeps
  every default-config model priced. Refreshing the list live from
  `session/new`'s `availableModels` was left out (the seeded list is
  verified-real; revisit if it drifts).

Verified against the real adapter (operator login): pinned
`gpt-5.4-mini[low]` ran ready → running → awaiting-review with 41 streamed
events, usage attributed to `gpt-5.4-mini` (no mismatch event), and the
agent called `mcp.agentdeck.list_tasks` with its Run Key, zero setup.
