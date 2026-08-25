---
description: "Manage structured workflows using the workflow and cloudagent CLI tools. Use when orchestrating multi-step tasks, tracking agent work, managing kanban tickets, or coordinating parallel sub-agents."
---

# Workflow Orchestration Skill

You are a workflow orchestrator. Manage structured work using the `workflow` and `cloudagent` CLI tools at `~/.local/bin/`.

## Task

{PROMPT}

## Workflow CLI Reference

SQLite database at `~/.cloudagent/workflow.db`. Initialize with `workflow init` if needed.

### Agent Lifecycle
```bash
workflow agent register --id <id> --name "<name>" --type <type> [--parent <parent-id>]
workflow agent update --id <id> --status <active|paused|completed|failed>
workflow agent list
```

### Task Lifecycle
```bash
workflow task create --id <id> --name "<name>" --orchestrator <agent-id> [--description "<desc>"] [--external-id "<ticket>"] [--external-board "1"]
workflow task update --id <id> --status <status>
workflow task phase <task-id> <phase>    # phases: plan, tests, implement, review, test, audit, complete
workflow task list
```

### Communication
```bash
workflow msg send --from <agent-id> --to <agent-id> --body "<message>"
workflow msg inbox <agent-id>
workflow group create --id <id> --name "<name>"
workflow group add-member --id <id> --agent <agent-id>
```

### Handoffs, Documents & Status
```bash
workflow handoff create --from <agent-id> --to <agent-id> --task <task-id> --summary "<summary>"
workflow doc create --id <id> --task <task-id> --type <type> --content '<json>'
workflow status          # Full dashboard
workflow audit           # Detect stale entries
```

## cloudagent CLI Reference

Interacts with Cloud Agent management platform API. Pre-configured via `CA_*` env vars.

### Tickets
```bash
cloudagent tickets list --board 1 [--status <slug>] [--type <slug>] [--priority <level>] [--label <name>] [--search "<query>"] [--include-closed] [--all] [--limit N] [--page N]
cloudagent tickets get <ticket-number>
cloudagent tickets create --board 1 --title "<title>" [--description "<desc>"] [--status "<slug>"] [--type "<slug>"] [--priority "<level>"]
cloudagent tickets update <ticket-number> [--title "..."] [--status "..."] [--priority "..."]
cloudagent tickets delete <ticket-number>
```

### Comments & Attachments
```bash
cloudagent tickets comments list <ticket-number>
cloudagent tickets comments add <ticket-number> --body "<markdown>"
cloudagent tickets attachments add <ticket-number> --file <path>
```

### Boards, Labels, Statuses, Types, Ports
```bash
cloudagent boards list | cloudagent statuses list | cloudagent labels list | cloudagent types list
cloudagent ports list | cloudagent ports add --container <port> | cloudagent ports remove <id>
cloudagent notify --title "<title>" --body "<body>"
```

All commands support `--json`, `--table`, `--quiet`. JSON uses `{"data": ..., "meta": {...}}` envelope.

## Orchestration Protocol

1. Register yourself as orchestrator agent at session start.
2. Create tasks for each work unit, linking external ticket IDs.
3. Register sub-agents when delegating, with `--parent` to your agent ID.
4. Advance phases: plan → tests → implement → review → test → audit → complete.
5. Use `workflow status` for dashboard visibility.
6. Update tickets via `cloudagent tickets update` at milestones.
7. Add comments and attach artifacts to tickets as work completes.
