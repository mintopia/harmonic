# Steering a running task injects mid-turn, falling back to the next turn boundary

> **Amended 2026-08-17.** The original decision below queued every steer for the
> next turn boundary and never injected mid-turn. Operators found that too slow:
> a steer should land *as soon as possible*, not after the current turn finishes.
> Harmonic now injects the steer into the running turn when the harness supports
> it (ACP `_session/steering`), and keeps the boundary queue only as a fallback.
> See **Amendment: mid-turn injection** at the end. The original reasoning is
> preserved for the record.

An operator can redirect a task's running agent by sending a steering message:
`POST /api/tasks/:id/steer` with `{ text }`. This handles an agent that has gone
off-track, or one that ended its turn and parked waiting for a prompt. When the
harness supports mid-turn steering the message is injected into the agent's
current turn immediately (pre-empting the current generation without cancelling
it); otherwise, or when the agent has parked between turns, it is held on the
run's in-memory steer queue (`ActiveRun.steerQueue` in `execution/runner.ts`)
and sent as a fresh prompt turn at the **next turn boundary**, ahead of any
auto-drive continue nudge and without spending the continue budget.

This is a lightweight, one-directional nudge, not a back-and-forth. A running
task is not a Conversation (ADR-0006): it has one job to finish, review-gated,
and the operator watches rather than chats. Steering is the escape hatch for the
two cases the Runner otherwise handles badly: an agent confidently doing the
wrong thing, and an agent that ended its turn to "wait for the user" that will
never come.

## Considered options

- **Cancel the in-flight turn and re-prompt (rejected, the Conversation
  `interrupt` model).** `ConversationDriver.interrupt` sends ACP
  `session/cancel` and re-prompts, because a chat is interactive and a stale
  half-answer is worthless. A task's turn is *work*: cancelling it mid-tool-call
  discards real progress (an edit half-applied, a command half-run) and the
  Runner would then settle a `cancelled` turn. For steering, losing the current
  turn's work is the wrong trade. Steers are things like "also consider X" or
  "you're off-track, re-read the tests".
- **Queue and deliver at the turn boundary (chosen).** The agent's current turn
  finishes cleanly; the steer opens the next turn. The transcript stays honest:
  a `steer_queued` lifecycle event marks acceptance and a `steer_delivered` one
  marks the turn it opened, with no illusion of seamless mid-thought
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
  never consume the continue budget. Settle logic is unchanged: more turns run
  before it, then the run settles from the final turn's outcome as before.
- `Runner.steer(taskId, text)` returns whether an active run was found; the route
  maps `false` to a 409 (`invalid_state`). It appends a `steer_queued` event on
  accept and the drive loop appends `steer_delivered` when the turn opens.
- `POST /tasks/:id/steer` is **operator-only**, excluded from `scopedKeyAllowed`
  alongside force-complete. An agent drives its own turn; it does not steer
  itself.
- The former "inherent, tiny race" is now closed. A steer arriving after the loop
  broke to settle used to be silently queued and dropped. `ActiveRun.steerable`
  is a synchronous gate: `steer()` rejects (409) the instant `drive()` commits
  to settling, and `drive()` closes the gate with no `await` between the loop
  exit and the close, then drains any steer that raced in before it as a final
  turn. A steer is therefore either delivered or honestly refused, never
  accepted-then-lost.

## Amendment: mid-turn injection (2026-08-17)

The original decision above prized transcript honesty over latency: every steer
waited for the turn boundary so there was never "an illusion of seamless
mid-thought redirection." In practice the wait is the wrong trade: an operator
who sees an agent going wrong wants it to course-correct *now*, mid-turn, not
after it finishes the wrong work. The rejected "cancel and re-prompt" option is
still wrong (it discards the current turn's real progress), but there is a third
option the original ADR did not have: inject **without** cancelling.

The ACP harness for the `claude` adapter (`@agentclientprotocol/claude-agent-acp`
≥ 0.69) exposes `_session/steering`: a request that, while a turn is in flight,
pushes the operator's message into the running turn at steer priority `now`,
pre-empting the current generation without cancelling the turn. The harness
returns `{ outcome: "injected" }` promptly; the steered message's output streams
over `session/update`, and the original `session/prompt` Harmonic is awaiting
settles at the SDK's `idle` after the steered work runs. So the injection rides
the *existing* prompt await in `Runner.drive`, with no change to the drive loop's
turn accounting, usage collection, or settle logic.

**Decision.** `Runner.steer` injects when a turn is in flight and the harness
supports it, and queues otherwise:

- **A turn is in flight (`ActiveRun.idle === false`) and the harness supports
  steering** → send `_session/steering` with the message and
  `_meta.steering.idleBehavior = "promptRequired"`. On `injected`, record a
  `steer_injected` lifecycle event and return. The boundary queue is untouched.
- **The session is idle** (the turn ended between the in-flight check and the
  RPC) → the opt-in makes the harness return `promptRequired` and start no turn;
  we fall through to the boundary queue. Opting in is what keeps an idle steer
  from making the harness silently open an untracked turn.
- **The harness does not implement `_session/steering`** (codex, copilot, or an
  older claude-acp) → the JSON-RPC request rejects with "method not found";
  `ActiveRun.steerSupported` is latched `false` so it is probed only once, and
  every steer for that run falls straight through to the boundary queue, the
  original behavior, unchanged.

**Consequences.**

- Capability is discovered by try-and-fallback on the first in-flight steer per
  run, not from a handshake flag: the ACP handshake exposes no steering
  capability today, and try-and-fallback needs no trust in an unverified shape.
- Transcript honesty is preserved differently: a `steer_injected` event marks
  the injection, and the steered message's own output is streamed and recorded
  as ordinary `session/update` events, so the redirect is visible in the run's
  event stream rather than hidden. Usage still accrues to the single turn the
  steer landed in: the injected message is part of that turn, not a new one.
- `Runner.steer` is now `async` (it awaits the inject RPC); the route awaits it.
  The synchronous `steerable` gate is preserved: injection is only attempted
  while a turn is in flight, a window in which `drive()` is parked on the main
  prompt await and cannot reach the settle path, and the boundary-queue
  fallback re-checks the gate after the RPC await before enqueuing.
- Conversations (`ConversationDriver.interrupt`) still cancel-and-re-prompt;
  moving them onto `_session/steering` is a possible follow-up, out of scope
  here: a Conversation is interactive and its cancel semantics are deliberate.
