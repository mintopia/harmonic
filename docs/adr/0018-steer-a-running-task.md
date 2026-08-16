# Steering a running task queues, delivered at the next turn boundary

An operator can redirect a task's running agent — for one that has gone
off-track, or one that ended its turn and parked waiting for a prompt — by
sending a steering message: `POST /api/tasks/:id/steer` with `{ text }`. The
message is **not** injected into the agent's current turn. It is held on the
run's in-memory steer queue (`ActiveRun.steerQueue` in `execution/runner.ts`)
and sent as a fresh prompt turn at the **next turn boundary**, ahead of any
auto-drive continue nudge and without spending the continue budget.

This is a lightweight, one-directional nudge — not a back-and-forth. A running
task is not a Conversation (ADR-0006): it has one job to finish, review-gated,
and the operator watches rather than chats. Steering is the escape hatch for the
two cases the Runner otherwise handles badly — an agent confidently doing the
wrong thing, and an agent that ended its turn to "wait for the user" that will
never come.

## Considered options

- **Cancel the in-flight turn and re-prompt (rejected — the Conversation
  `interrupt` model).** `ConversationDriver.interrupt` sends ACP
  `session/cancel` and re-prompts, because a chat is interactive and a stale
  half-answer is worthless. A task's turn is *work*: cancelling it mid-tool-call
  discards real progress (an edit half-applied, a command half-run) and the
  Runner would then settle a `cancelled` turn. For steering — "also consider
  X", "you're off-track, re-read the tests" — losing the current turn's work is
  the wrong trade.
- **Queue and deliver at the turn boundary (chosen).** The agent's current turn
  finishes cleanly; the steer opens the next turn. The transcript stays honest —
  a `steer_queued` lifecycle event marks acceptance and a `steer_delivered` one
  marks the turn it opened — with no illusion of seamless mid-thought
  redirection. This is the same honesty contract as Conversation steering, minus
  the cancel.
- **A new persisted column / table for pending steers (rejected).** The queue
  only matters while a run is driving in-process; a steer for a run that is not
  active here is a no-op (409). Like `agentFinished`/`escalateReason`, it lives
  on the in-memory `ActiveRun`, and each message is durably recorded as a run
  *event* (so it survives on the stream and in replay). No migration.

## Consequences

- A native run is no longer strictly single-turn: with nothing queued it still
  settles after one turn, but a queued steer gives it another. The unified loop
  in `Runner.drive` drains the steer queue at every turn boundary for native and
  afk runs alike; `attempt` counts only auto-drive continue nudges, so steers
  never consume the continue budget. Settle logic is unchanged — more turns run
  before it, then the run settles from the final turn's outcome as before.
- `Runner.steer(taskId, text)` returns whether an active run was found; the route
  maps `false` to a 409 (`invalid_state`). It appends a `steer_queued` event on
  accept and the drive loop appends `steer_delivered` when the turn opens.
- `POST /tasks/:id/steer` is **operator-only** — excluded from `scopedKeyAllowed`
  alongside force-complete. An agent drives its own turn; it does not steer
  itself.
- There is an inherent, tiny race: a steer that arrives after the loop has
  broken to settle is not delivered (the run is finishing). This matches the
  Conversation model's own post-turn window and is acceptable — the operator
  re-attempts or opens a Conversation if they miss it.
