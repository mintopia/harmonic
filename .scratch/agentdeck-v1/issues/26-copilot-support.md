# Copilot support

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Fill in the Copilot Harness Adapter from issue 25's findings, to full
parity with Claude: Runs execute over ACP, stream events, hit the review
gate, the per-Task model is honored (observed model surfaced on
contradiction), and Usage carries a per-model breakdown via a session-log
Usage Collector where the spike proved one derivable.

Scope, all shaped by spike findings:

- **Spawn tweaks**: the verified model-pinning mechanism; quirk
  workarounds. Correct `defaultConfig()` if the spike contradicts
  `copilot --acp` or the shipped model list.
- **Usage Collector**: per-model breakdown from Copilot's session log with
  the standard flush-race retry semantics — or, if the spike classified
  per-model usage as underivable, honest degradation to ACP aggregate
  totals (never a fake breakdown), with the parity gap recorded as a
  follow-up.
- **AI Units**: if the spike found per-Run consumption observable, add the
  optional Usage field and show it on the run detail as actual spend
  alongside Cost — a separate figure, never folded into Cost (decision Q4;
  see CONTEXT.md "AI Unit").
- **MCP registration**: ACP `session/new` `mcpServers` if verified;
  env-var fallback otherwise.
- **Legible auth failure**: an unauthenticated spawn fails the Run with a
  recognizable reason.
- **Pricing**: add `gpt-5.2` to `DEFAULT_PRICES` (OpenAI API rates) so
  Copilot runs on it stop flagging Cost incomplete. Cost stays uniformly
  API-equivalent for Copilot (decision Q4).
- If the model is not pinnable: collapse the Copilot `models` list to its
  verified default and fix the Task form display (Q7).

## Acceptance criteria

- [ ] A real Copilot Task runs end-to-end: ready → running → awaiting-review, with streamed session updates in the run detail
- [ ] The Task's model demonstrably reaches Copilot, and a contradicting observed model is surfaced on the run
- [ ] Usage on a finished Copilot run matches the spike's classification: per-model breakdown, or honest aggregate-only with the gap filed as a follow-up
- [ ] Cost on a `gpt-5.2` Copilot run prices with no incomplete flag
- [ ] AI Units appear on the run detail as actual spend iff the spike proved them observable; Cost aggregates are unchanged either way
- [ ] The spawned Copilot agent can call AgentDeck's MCP tools using its Run Key with zero operator setup
- [ ] An unauthenticated Copilot spawn fails the Run with a legible reason
- [ ] Tests cover the Copilot Usage Collector (or aggregate-only path) against captured fixtures from the spike

## Blocked by

- Issue 25 (spike findings)
- Issue 23 (adapter seam)

## Comments
