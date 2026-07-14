# Live Run Event streaming and replay

Status: done

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

- [x] Watching a running Task shows Run Events arriving live without refresh
- [x] Message chunks, thoughts, tool calls, and plan updates are each rendered distinctly
- [x] Subagent activity appears in the stream where the Harness surfaces it
- [x] Any historical Run's full event stream can be replayed from the Run's page
- [x] Tests drive the stub harness and assert events arrive over the WebSocket stream in order

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`

## Comments

**2026-07-14 (agent):** Done. `EventBus` fans run events, run state
changes, and task state changes out to a firehose WebSocket at `/api/ws`
(src/server/ws.ts); the SPA subscribes with auto-reconnect (web/src/ws.ts)
so the board and open task detail update live without polling. The event
stream renders message chunks, thoughts, tool calls (with a subagent badge
from `parentToolUseId`), and plan snapshots distinctly; replay loads the
same persisted records over REST and live events append to it — one
representation. Tests assert in-order WS delivery while the task is still
running and replay/stream equality.
