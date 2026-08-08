# Plan: stop settling AFK runs that only parked

## Problem
Harmonic runs **exactly one** `session/prompt` per run, then settles (`runner.ts:388-416`).
Every `end_turn` resolves `driver.prompt()` — whether the agent **finished**, **gave up**,
or just **parked to wait** on background work. For an afk run the ticket isn't closed yet,
so `onCompleted` returns `'unresolved'` → `settleFailedOrRetry` retries from scratch or
escalates. A parked agent gets its work thrown away.

Proven by the diagnosis session itself: it parked to ask a question, Harmonic saw
`end_turn`, marked it complete.

## Decision (locked with user)
Invert the assumption: **a run is not done unless the agent explicitly says so.**
- **Finish signal** = ticket closed (existing `agentResolved`) **OR** the agent calls a new
  `finish_task` MCP tool.
- **No finish signal** on `end_turn` → **continue** the warm session, up to `continueAttempts`
  (configurable, **default 1**), then fall through to today's `unresolved` → retry/escalate.
- **Continue prompt** carries a "you are running **unattended**" reminder.
- **Initial drive prompt** carries that same reminder.
- Scope: continue-loop **and** finish tool, together.

## Why the finish tool works over stateless MCP
The harmonic MCP server is stateless per HTTP request but shares one `AppContext`
(`ctx.runner`). The runner holds `active: Map<runId, ActiveRun>` and `ActiveRun` already
carries `taskId`. So `finish_task({taskId})` → `ctx.runner.markAgentFinished(taskId)` flips
an in-memory flag on the active run; the runner's post-prompt loop reads it. No schema
change — mirrors how `escalating` is already an in-run flag.

## Edits

### 1. `runner.ts` — the continue-loop (core)
Wrap the single prompt (`388-411`) in a loop. `active` gains an `agentFinished` flag.
```
let attempt = 0;
let result;
while (true) {
  result = await driver.prompt([{ type: 'text', text: promptText }]);
  if (active.escalateReason) { escalating = active.escalateReason; break; } // agent asked for a human
  if (escalating) break;                          // permission escalation → existing path
  if (!autoDriven) break;                          // native single-turn unchanged
  if (active.agentFinished) break;                 // explicit finish tool
  if (await this.autoDrive!.isResolved(task)) break; // ticket closed
  if (attempt >= this.autoDrive!.continueAttempts()) break; // cap → unresolved path
  attempt++;
  record('lifecycle', { event: 'continue', attempt });
  promptText = this.autoDrive!.continuePrompt(task);
}
```
Existing settle block (`391-416`) runs **once** on the final `result`, unchanged — a
still-unresolved run after the cap flows to `settleFailedOrRetry` exactly as today.
Session stays warm (driver disposed only in `finally`, like `ConversationDriver`).

- Add `agentFinished: boolean` and `escalateReason: string | null` to `ActiveRun`.
- Add `markAgentFinished(taskId)` and `markEscalate(taskId, reason)`: find active run by task,
  set flag. (No-op if no active run.) An agent escalate reuses the existing `escalating`
  branch → `settleEscalated`, so the run surfaces to a human instead of retrying.

### 2. `auto-drive.ts` — helpers
- `isResolved(task)` — expose the existing ticket-closed check (extract from `agentResolved`)
  as a cheap public predicate for the loop. (`onCompleted` keeps using it + its merge/PR logic.)
- `continueAttempts()` — `this.getConfig().drive.continueAttempts`.
- `continuePrompt(task)` — short re-prompt with the unattended reminder (below).
- `prompt(task)` — append `UNATTENDED_REMINDER` to the initial drive prompt.

### 3. `config.ts` — config + prompt copy
- Add to `drive` block: `continueAttempts: z.number().int().min(0).default(1)` (0 = pure
  single-turn). Update the defaults object (`239-242`) and the block comment.
- Add `UNATTENDED_REMINDER` constant: states the agent runs unattended, must not idle-wait
  for a human, should either keep working or — when genuinely done — close the ticket and
  call `finish_task`.

### 4. `mcp/server.ts` — the finish tool
Register `finish_task` (always available, not behind `agentReview` — it is a completion
*signal*, not a merge gate; the actual close/merge still goes through `onCompleted` fate):
```
server.registerTool('finish_task', {
  description: 'Signal that this Task is finished so Harmonic stops re-prompting it. ' +
    'Call only when the work is genuinely complete (and you have closed the tracker ticket).',
  inputSchema: { ...taskId, summary: z.string().optional() },
}, wrap(({ taskId }) => { ctx.runner.markAgentFinished(taskId); return { acknowledged: true }; }));
```
Also register `escalate_task` (always available) for the agent-needs-a-human case (e.g.
parking to ask a question — the exact case the diagnosis session hit):
```
server.registerTool('escalate_task', {
  description: 'Raise this Task to a human and stop the run. Call when you are blocked on a ' +
    'decision or need input you cannot get unattended. Include why in `reason`.',
  inputSchema: { ...taskId, reason: z.string().min(1) },
}, wrap(({ taskId, reason }) => { ctx.runner.markEscalate(taskId, reason); return { acknowledged: true }; }));
```
The drive prompt must tell the agent its Harmonic `taskId` → add a `{taskId}` placeholder to
`DEFAULT_DRIVE_PROMPT` + `buildDrivePrompt` fields, filled in `AutoDrive.prompt()`. The
`UNATTENDED_REMINDER` names all three tools: keep working, `finish_task` when done,
`escalate_task` when you need a human — never idle-wait.

### 5. Tests
- runner: parked run (ticket open, no finish) continues then, past cap, hits unresolved;
  finish flag exits the loop; ticket-closed exits the loop; `continueAttempts: 0` = one turn.
- auto-drive: `continuePrompt` / initial prompt contain the reminder; `isResolved` matches
  ticket state.
- mcp: `finish_task` calls `markAgentFinished`.

### 6. Escalate-for-input (in scope)
`escalate_task` MCP tool (edit #4) → `markEscalate` → existing `settleEscalated`. Covers the
agent-parks-to-ask-a-human case. Test: escalate flag routes to `settleEscalated`, not retry.
