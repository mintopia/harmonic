# Codex support

Status: ready-for-agent

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

- [ ] A real Codex Task runs end-to-end: ready → running → awaiting-review, with streamed session updates in the run detail
- [ ] The Task's model demonstrably reaches Codex (verified per the spike's actual-model check), and a contradicting observed model is surfaced on the run
- [ ] Usage on a finished Codex run has a per-model breakdown from the rollout log (source `session-log` or `combined`), and Cost prices it with no incomplete flag
- [ ] The spawned Codex agent can call AgentDeck's MCP tools using its Run Key with zero operator setup
- [ ] An unauthenticated Codex spawn fails the Run with a legible reason
- [ ] Tests cover the Codex Usage Collector against captured rollout-log fixtures from the spike

## Blocked by

- Issue 22 (spike findings)
- Issue 23 (adapter seam)

## Comments
