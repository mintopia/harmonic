---
title: Notifications
description: How Harmonic's global Notification Channels subscribe to task events and deliver them to Discord, Slack, email, or a generic webhook.
---

Harmonic notifies the outside world when the queue empties out or when a
Task hits a milestone: created, running, awaiting review, done, or failed. A
**Notification Channel** is the thing that receives those events; each
channel picks which events it cares about, and a Task can layer its own
overrides on top of the global subscriptions.

## Notification Channels

A Notification Channel is a **global-only** setting. Per
[ADR 0012](/harmonic/how-it-works/design-decisions/), notifications are
machine-level, not per-workspace. Channels are created and managed via the
REST API / MCP; see [API & MCP](/harmonic/using-harmonic/api-and-mcp/) and
[Settings & overrides](/harmonic/using-harmonic/settings-and-overrides/) for
where they live in configuration.

Every channel has:

- a `name`,
- a `type`,
- a type-specific `config`, and
- an `events` array it subscribes to.

### Channel types

| Type | `config` shape | Delivery |
| --- | --- | --- |
| `discord` | `{ url }` (a Discord webhook URL) | HTTP POST `{ "content": <text> }` to the URL |
| `slack` | `{ url }` (a Slack incoming-webhook URL) | HTTP POST `{ "text": <text> }` to the URL |
| `webhook` | `{ url, secret? }` | HTTP POST the generic JSON payload (below) to the URL |
| `email` | `{ smtp: { host, port, secure?, user?, pass? }, from, to }` | SMTP send via nodemailer; subject = the summary text, body = the pretty-printed JSON payload |

For the chat and email channel types, Harmonic builds a human-readable
summary text:

```
Harmonic: task <id> <label> — "<excerpt>"
```

where the prompt excerpt is truncated to 80 characters. For `queue.idle`
the summary is instead:

```
Harmonic: queue is idle — nothing left to run
```

Event labels used in the summary: created / started running / awaiting
review / completed / FAILED / queue idle.

## Events

Six events exist:

| Event | Fires when |
| --- | --- |
| `task.created` | A Task is created |
| `run.started` | A Run starts |
| `task.awaiting-review` | A Task lands in the review gate |
| `task.completed` | A Task is accepted |
| `task.failed` | A Task fails |
| `queue.idle` | The queue has nothing left to run |

A new channel defaults to subscribing to only `task.awaiting-review` and
`task.failed`, a deliberately low noise-floor covering just the
review-gate and failure moments. A channel may subscribe to any subset of
the six.

## Fan-out and per-task overrides

When an event fires, Harmonic delivers it to the union of:

1. every channel globally subscribed to that event, plus
2. any channel bound to that specific Task as a **per-task override**. A
   Task can add or remove channel overrides so a channel fires for it even
   when that channel isn't globally subscribed to the event.

Delivery is fire-and-forget: a failure, or a non-2xx response, is logged
and dropped. There are no retries in v1.

## Generic webhook payload

The `webhook` channel type delivers a `POST` request with
`Content-Type: application/json`.

### Body

```json
{
  "event": "task.awaiting-review",
  "timestamp": 1784020800000,
  "task": {
    "id": 3,
    "prompt": "Fix the flaky login test",
    "state": "awaiting-review",
    "harness": "claude",
    "model": "claude-sonnet-5",
    "priority": "normal",
    "isolationMode": "worktree",
    "workingDir": "/home/coder/project"
  }
}
```

- `event`: one of the six event types.
- `timestamp`: milliseconds since the Unix epoch, set at send time.
- `task`: present for every event **except** `queue.idle`. Fields: `id`,
  `prompt`, `state`, `harness`, `model`, `priority`, `isolationMode`,
  `workingDir`.

### Headers

| Header | Value |
| --- | --- |
| `X-Harmonic-Event` | The event type, duplicated for cheap routing. |
| `X-Harmonic-Signature` | Present only when the channel has a `secret` configured. `sha256=<hex>`, where `<hex>` is `HMAC-SHA256(rawRequestBody, secret)`. |

Verify a signed payload by recomputing the HMAC over the exact raw bytes
received and comparing it against the header with a constant-time
comparison.
