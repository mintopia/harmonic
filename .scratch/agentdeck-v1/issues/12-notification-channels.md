# Notification Channels

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Announce the moments that matter. Operators configure Notification
Channels — Discord webhook, Slack webhook, Generic webhook, or Email via
configured SMTP — and subscribe each Channel to a set of event types
(task.created, run.started, task.awaiting-review, task.completed,
task.failed, queue.idle), defaulting to awaiting-review + failed so the
noise floor stays low. Per-Task overrides let a specific Task announce
itself to a specific Channel.

Generic webhooks send a documented JSON payload with an optional
HMAC-SHA256 signature header so receiving systems can verify authenticity.

## Acceptance criteria

- [x] Channels of all four types can be created, edited, and deleted in the UI, with delivery configuration per type
- [x] Each Channel's event-type subscriptions are editable and default to awaiting-review + failed
- [x] Lifecycle events fire notifications to every subscribed Channel; unsubscribed events stay silent
- [x] Per-Task overrides route that Task's events to the chosen Channel
- [x] The generic webhook payload matches its documentation and carries a verifiable HMAC-SHA256 signature header when a secret is configured
- [x] Tests capture webhook deliveries with a local HTTP listener (including HMAC verification) and assert email via a dev SMTP sink

## Blocked by

- `05-review-accept-reject.md`

## Comments

**2026-07-14 (agent):** Done. `ChannelService` + `Notifier`
(src/notifications/): four channel types with zod-validated per-type
config, subscriptions defaulting to awaiting-review + failed, per-task
overrides (task_channels) that route all of a task's events to the chosen
channel. Events emitted from TaskService state transitions (created /
run.started / awaiting-review / completed / failed — interrupted recovery
included) plus queue.idle when the last run drains with nothing ready.
Generic webhook payload documented in docs/webhooks.md with
X-AgentDeck-Event and optional HMAC-SHA256 X-AgentDeck-Signature over the
raw body; email via nodemailer/SMTP. Tests capture webhooks with a local
HTTP listener (HMAC verified against an independent recomputation) and
email with an smtp-server dev sink. UI: Channels modal (CRUD + event
checkboxes) and a per-task "Notify" routing row in the task detail.
