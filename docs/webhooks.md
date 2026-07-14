# Generic webhook payload

Generic-webhook Notification Channels deliver an HTTP `POST` with
`Content-Type: application/json` for every subscribed event (and every
event of a Task that overrides to the Channel).

## Body

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

- `event` — one of `task.created`, `run.started`, `task.awaiting-review`,
  `task.completed`, `task.failed`, `queue.idle`.
- `timestamp` — milliseconds since the Unix epoch, set at send time.
- `task` — present for every event except `queue.idle`.

## Headers

- `X-Harmonic-Event`: the event type, duplicated for cheap routing.
- `X-Harmonic-Signature`: present when the Channel has a `secret`
  configured. Value is `sha256=<hex>` where `<hex>` is
  `HMAC-SHA256(rawRequestBody, secret)`. Verify by recomputing over the
  raw bytes you received and comparing with a constant-time comparison.

Non-2xx responses are logged and dropped; there are no retries in v1.
