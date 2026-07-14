# Notification Channels

Status: ready-for-agent

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

- [ ] Channels of all four types can be created, edited, and deleted in the UI, with delivery configuration per type
- [ ] Each Channel's event-type subscriptions are editable and default to awaiting-review + failed
- [ ] Lifecycle events fire notifications to every subscribed Channel; unsubscribed events stay silent
- [ ] Per-Task overrides route that Task's events to the chosen Channel
- [ ] The generic webhook payload matches its documentation and carries a verifiable HMAC-SHA256 signature header when a secret is configured
- [ ] Tests capture webhook deliveries with a local HTTP listener (including HMAC verification) and assert email via a dev SMTP sink

## Blocked by

- `05-review-accept-reject.md`
