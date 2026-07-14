# PRD: AgentDeck v1

Status: ready-for-agent

## Problem Statement

Developers working in Coder workspaces want to hand off well-defined units
of work to autonomous coding agents (Claude, Codex, Copilot) and get on
with something else. Today that means babysitting interactive CLI sessions
one at a time: there is no way to queue work up, express that one piece of
work depends on another, see what an agent is doing (or spending) while
away from the terminal, get notified when something needs a human, or let
agents themselves schedule follow-up work. Running agents unattended also
means their output lands unreviewed in the working copy.

## Solution

AgentDeck is a single self-hosted web application that runs inside the
Coder workspace. The operator authors Tasks — a prompt plus execution
settings (Harness, model, Working Directory, Isolation Mode, Priority) —
and wires Dependencies between them. An Auto-Runner executes ready Tasks
unattended, driving each Harness over ACP and streaming every Run Event to
a kanban-style web UI in real time. Finished work lands in an
awaiting-review inbox; accepting a worktree-mode Task merges its branch.
Notification Channels (Discord, Slack, generic webhook, email) announce the
moments that matter. Agents themselves get an MCP server (with an
auto-injected scoped API Key) to create and manage Tasks, enabling
autonomous pipelines. Configuration is portable via a dotfiles-style
Config Repo.

## User Stories

### Task authoring & lifecycle

1. As an operator, I want to create a Task with a prompt, so that an agent can execute work I've defined without me at the keyboard.
2. As an operator, I want to pick the Harness (Claude, Codex, Copilot) per Task, so that I can use the right agent for each job.
3. As an operator, I want to pick a model from a configured list or type any model ID, so that I control cost and capability per Task.
4. As an operator, I want configured default Harness and model values, so that creating a routine Task requires only a prompt.
5. As an operator, I want to save a Task as a draft, so that I can author work-in-progress without it being executed.
6. As an operator, I want to set a Task's Working Directory (defaulting from configuration), so that Tasks can target different checkouts in my workspace.
7. As an operator, I want to choose a Task's Isolation Mode (direct or worktree), overriding the global default, so that I decide between in-place editing and branch isolation per Task.
8. As an operator, I want to set a Task's Priority (high/normal/low), so that urgent work jumps the queue.
9. As an operator, I want to cancel a Task at any non-terminal state (killing its Run if running), so that I can abandon work that is no longer wanted.
10. As an operator, I want to re-queue a failed Task with optional feedback appended to its prompt, so that retries can learn from what went wrong.
11. As an operator, I want to edit a draft or ready Task's prompt and settings, so that I can refine work before it runs.

### Dependencies

12. As an operator, I want to declare that a Task depends on other Tasks, so that work executes in the right order.
13. As an operator, I want a Task with unmet Dependencies to sit in blocked and become ready automatically when the last Dependency completes, so that pipelines advance without my involvement.
14. As an operator, I want only *completed* (accepted) Tasks to satisfy dependents, so that unreviewed or failed work never feeds downstream Tasks.
15. As an operator, I want dependents of a failed Dependency to stay blocked with a visible "blocked on failed dependency" flag, so that a retryable hiccup doesn't destroy my pipeline.
16. As an operator, I want a "cancel Task and its dependents" action, so that I can tear down an obsolete chain in one step.
17. As an operator, I want cycle creation rejected when I add a Dependency, so that the graph stays executable.

### Auto-Runner

18. As an operator, I want a global Auto-Runner toggle, so that I choose between hands-on and unattended operation.
19. As an operator, I want the Auto-Runner to pick the highest-Priority, oldest ready Task, so that execution order is predictable.
20. As an operator, I want a configurable maximum number of concurrent Runs, so that I control load and collision risk.
21. As an operator, I want manual "run now" on any ready Task even when the Auto-Runner is off, so that I stay in control in hands-on mode.

### Execution & review

22. As an operator, I want each execution attempt recorded as a distinct Run under its Task, so that history survives retries.
23. As an operator, I want worktree-mode Runs to execute on their own branch in a temporary git worktree, so that concurrent or risky work never touches my checkout.
24. As a reviewer, I want finished Tasks to land in awaiting-review, so that nothing an agent produced is treated as done until I've looked at it.
25. As a reviewer, I want to Accept a worktree-mode Task and have its branch merged into the base branch automatically, so that acceptance is one click, not a git session.
26. As a reviewer, I want a merge conflict on Accept to return the Task to awaiting-review with the conflict surfaced, so that I can resolve it deliberately.
27. As a reviewer, I want to Reject a Task with feedback, so that the failure reason travels with the re-queued Task.
28. As an operator, I want Runs orphaned by an AgentDeck restart marked failed with reason "interrupted" (never silently re-run), so that a workspace reboot can't cause surprise re-execution on a dirty directory.

### Observability & statistics

29. As an operator, I want to watch a running Task's Run Events (messages, thoughts, tool calls, plan updates) stream live in the UI, so that I can see what the agent is doing right now.
30. As an operator, I want subagent activity surfaced within the Run's event stream to the extent the Harness exposes it over ACP, so that delegated work isn't a black box.
31. As an operator, I want to replay the full event stream of any historical Run, so that I can audit what an agent did after the fact.
32. As an operator, I want per-Run Usage (input/output/cache tokens per model, tool-call tallies), so that I know what each attempt cost.
33. As an operator, I want Usage aggregated per Task and across time ranges on a stats page, so that I can see spend and tool patterns at a glance.
34. As an operator, I want a kanban board with a column per lifecycle state as the home screen, so that the system's whole state is one glance.
35. As an operator, I want a filterable, sortable table view of Tasks, so that I can do bulk housekeeping.
36. As a reviewer, I want the awaiting-review column to function as my inbox (with diffstat and branch info for worktree Runs), so that reviewing is a tight loop.

### Notifications

37. As an operator, I want to configure Discord, Slack, generic-webhook, and email Notification Channels, so that events reach me where I already am.
38. As an operator, I want each Channel subscribed to a chosen set of event types (defaulting to awaiting-review + failed), so that the noise floor stays low.
39. As an operator, I want per-Task notification overrides, so that a specific Task can announce itself to a specific Channel.
40. As an operator, I want generic webhooks sent as documented JSON with an optional HMAC signature header, so that receiving systems can verify authenticity.
41. As an operator, I want email notifications via configured SMTP, so that notifications work without any chat platform.

### MCP & API

42. As an agent, I want an MCP server reachable inside the workspace with tools to create, list, get, and update Tasks, manage Dependencies, queue, and cancel, so that I can schedule follow-up work autonomously.
43. As an agent, I want to read Task status and Run results over MCP, so that I can react to the outcomes of prior work.
44. As an agent, I want my Run's scoped API Key and the MCP endpoint injected into my environment automatically, so that I need no manual setup to use it.
45. As an operator, I want Accept/Reject excluded from MCP unless I enable the agent-review config flag, so that the merge gate stays human by default and full autonomy is a deliberate choice.
46. As an API client, I want a REST API covering everything the UI can do, authenticated by API Key, so that external tooling can drive AgentDeck.
47. As an operator, I want to create, name, and revoke API Keys and see per-key last-used times, so that I can manage and audit programmatic access.

### Auth & configuration

48. As an operator, I want a single username/password set via CLI or config on first run, so that my instance isn't open to anyone who can reach the port.
49. As an operator, I want web sessions for the UI and bearer API Keys for the API/MCP, so that each surface authenticates appropriately.
50. As an operator, I want to import configuration (harnesses, model lists, defaults, Channels, credentials, API Keys) from a git Config Repo at init, so that a fresh workspace is productive in one command.
51. As an operator, I want an explicit config pull to re-import from the Config Repo and an export that writes current config back to a committable file, so that my setup stays portable without background sync surprises.

## Implementation Decisions

- **Stack**: single Node/TypeScript process — Fastify HTTP API + WebSocket
  streaming, React/Vite/Tailwind SPA served embedded, Drizzle ORM on
  better-sqlite3. Distributed as an npm package (`npx agentdeck serve`),
  reachable through Coder port forwarding.
- **Persistence**: one SQLite database file (default `~/.agentdeck/`),
  holding all state including per-Run event history. No external services.
- **Domain shape**: Task (intent) has many Runs (attempts). Lifecycle:
  draft → blocked/ready → running → awaiting-review → completed | failed |
  cancelled, exactly as defined in `CONTEXT.md`. Only completed satisfies
  Dependencies; failure does not cascade.
- **Harness integration**: ACP only (see ADR-0001). Each Harness gets an
  adapter that spawns its CLI (Claude via `claude-code-acp`, Codex and
  Copilot native) and speaks stdio JSON-RPC. No one-shot CLI mode exists.
- **Run Events**: every ACP `session/update` is persisted and broadcast
  over WebSocket; the same records serve live view and replay.
- **Usage collection**: per-Harness UsageCollector — ACP `_meta`/extension
  fields first, native session-log parsing as fallback.
- **Isolation**: per-Task Isolation Mode with global default. Direct mode
  has no locking (accepted foot-gun). Worktree mode: branch
  `agentdeck/task-<id>-run-<n>` off the Working Directory's current branch;
  worktree removed after the Run, branch retained. Accept merges the branch
  (see ADR-0002); conflicts return the Task to awaiting-review.
- **Scheduler**: Auto-Runner with global toggle, Priority-then-FIFO pick
  order, configurable max concurrent Runs (default 1).
- **Crash recovery**: on startup, Runs still marked running are failed with
  reason `interrupted`; their Tasks go to failed and notify.
- **Model selection**: per-Harness model lists and default model defined in
  config; free-text model ID accepted per Task. No runtime discovery.
- **Notifications**: Channel = destination + event-type subscriptions
  (default: awaiting-review, failed) + per-Task overrides. Event types
  include task.created, run.started, task.awaiting-review, task.completed,
  task.failed, queue.idle. Generic webhook payload is documented JSON with
  optional HMAC-SHA256 signature header.
- **MCP server**: streamable HTTP on localhost, same authorization model as
  the REST API. Tools: task CRUD, dependency add/remove, queue, cancel,
  read runs/events. Accept/Reject tools exist only behind the agent-review
  config flag (default off). Each Run gets a minted scoped API Key and MCP
  endpoint injected into the spawned Harness's environment.
- **Auth**: single operator account; password set via CLI/config, hashed at
  rest; cookie sessions for the SPA; named revocable bearer API Keys for
  REST and MCP.
- **Config Repo**: dotfiles-style git repo imported on `init`, re-imported
  on explicit pull, exportable from live config. The database remains
  runtime truth; no background sync.

## Testing Decisions

- Tests assert **external behavior only**, through two seams:
  1. **Driving seam — the REST API.** All lifecycle, dependency,
     scheduler, review, auth, stats, and notification behavior is
     exercised via HTTP (plus the WebSocket stream for live events). UI
     tests stay thin; the API is the contract.
  2. **Driven seam — the ACP process boundary.** Tests register a **stub
     harness**: a small scripted ACP agent executable that replays
     configurable session updates (message chunks, tool calls, usage
     metadata, delays, exit behaviors). Production spawning/stdio code
     runs unmodified; no in-process mocks of the harness.
- Everything else is real: SQLite in a temp file per test suite, git
  worktree/merge behavior against throwaway repos created in test setup,
  webhook deliveries captured by a local HTTP listener, email asserted via
  a dev SMTP sink.
- Scenario coverage must include: dependency unblocking on accept (not on
  finish), blocked-on-failed flagging, priority-then-FIFO pick order,
  max-concurrency enforcement, merge-conflict-on-accept returning to
  awaiting-review, interrupted-run recovery on restart, HMAC signature
  verification, scoped-key injection into the stub harness's environment,
  and the agent-review flag gating MCP accept/reject.
- Greenfield repo: no prior art; these tests establish the house style.

## Out of Scope

- Multi-user accounts, roles, or read-only share links (single operator only).
- One-shot/CLI-flag harness execution (`claude -p` etc.) — ACP only, per ADR-0001.
- Push-to-remote or PR creation flows; merges are local (per ADR-0002).
- Runtime model discovery from harnesses.
- Directory locking or collision prevention in direct Isolation Mode.
- Auto-requeue of interrupted Runs.
- Background/watch sync of the Config Repo (explicit pull/export only).
- Event-history retention/pruning policies.
- Additional harnesses beyond Claude, Codex, and Copilot.
- Kanban drag transitions beyond those that map to real state transitions.

## Further Notes

- Riskiest assumption (flagged during design): the `claude-code-acp`
  adapter's fidelity — whether it surfaces subagent activity and usage
  metadata richly enough for the observability and statistics features.
  Worth a spike before deep implementation.
- The domain glossary lives in `CONTEXT.md`; ADR-0001 (ACP-only) and
  ADR-0002 (accept = merge) record the two decisions most likely to
  surprise a future contributor.
