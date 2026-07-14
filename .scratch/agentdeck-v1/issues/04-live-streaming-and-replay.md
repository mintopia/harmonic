# Live Run Event streaming and replay

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Real-time observability. Run Events are broadcast over WebSocket as they
are persisted, and the UI shows a running Task's stream live — messages,
thoughts, tool calls, and plan updates as they happen, including subagent
activity to the extent the Harness exposes it over ACP (calibrated by the
spike findings in issue 01).

The same persisted records power replay: the full event stream of any
historical Run can be stepped through after the fact. Live view and replay
render from one representation — no separate storage or format.

## Acceptance criteria

- [ ] Watching a running Task shows Run Events arriving live without refresh
- [ ] Message chunks, thoughts, tool calls, and plan updates are each rendered distinctly
- [ ] Subagent activity appears in the stream where the Harness surfaces it
- [ ] Any historical Run's full event stream can be replayed from the Run's page
- [ ] Tests drive the stub harness and assert events arrive over the WebSocket stream in order

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`
