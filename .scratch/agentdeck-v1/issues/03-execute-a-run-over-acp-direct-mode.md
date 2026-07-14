# Execute a Run over ACP (direct Isolation Mode)

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

The first real execution path. "Run now" on a ready Task spawns the Task's
Harness as a child process and drives it over ACP (stdio JSON-RPC, per
ADR-0001), executing in the Task's Working Directory in direct mode — in
place, no locking. Each attempt is recorded as a distinct Run under its
Task, and every ACP `session/update` is persisted as a Run Event against
that Run — these records are the source of truth for observability (live
view and replay come in a later slice; a basic Run detail page showing the
persisted events is enough here).

Lifecycle: ready → running when the Run starts; running → awaiting-review
when the Harness finishes cleanly; running → failed when it errors.
Cancelling a running Task kills its Run. On startup, any Runs still marked
running are failed with reason "interrupted" — never silently re-run — and
their Tasks move to failed.

This slice builds the PRD's driven test seam: a stub harness, a small
scripted ACP agent executable registered as a Harness in tests, replaying
configurable session updates (message chunks, tool calls, usage metadata,
delays, exit behaviors). Production spawning and stdio code runs
unmodified; no in-process mocks.

Apply findings from the claude-code-acp spike (issue 01) to the Claude
adapter's shape before going deep.

## Acceptance criteria

- [ ] "Run now" on a ready Task starts a Run: the Harness process is spawned and driven over ACP in the Task's Working Directory
- [ ] Each attempt is a distinct Run; retries create new Runs and history survives
- [ ] Every ACP session/update is persisted as a Run Event and visible on a Run detail page after the fact
- [ ] Clean finish moves the Task to awaiting-review; a Harness error moves it to failed
- [ ] Cancelling a running Task kills the Harness process and the Run
- [ ] After a process restart, in-flight Runs are marked failed with reason "interrupted" and are not re-executed
- [ ] The stub harness test seam exists and drives all of the above through real spawn/stdio code
- [ ] The kanban board reflects running and awaiting-review Tasks

## Blocked by

- `02-walking-skeleton-task-authoring-and-board.md`
