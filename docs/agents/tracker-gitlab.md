# Tracker adapter: GitLab

A repo whose issues live on GitLab (gitlab.com or self-hosted). Reads via the
REST v4 API with a personal-access token. Select it from
`docs/agents/issue-tracker.md`:

```
# Issue tracker: GitLab

Project: mintopia/harmonic
Host: https://gitlab.com
```

- **`Project:`** (required) — `group/repo` (URL-encoded for the API) or the
  numeric project id.
- **`Host:`** (optional, default `https://gitlab.com`) — the API base for a
  self-hosted instance.
- **`GITLAB_TOKEN`** (env var, required) — a personal-access token with `api`
  scope. Never put the token in the repo doc.

## What GitLab lacks (and how the adapter fills it)

The free tier has no native sub-issues or dependency links, so the adapter reads
the same body-line wayfinder conventions the GitHub doc prescribes as fallbacks,
and reverse-synthesises the `blocking` direction across the scan set — so the
normalised `Ticket` looks identical whatever the tracker:

- **Parent / Map membership** — a `Part of #<map>` line in the issue description.
- **Blocking** — a `Blocked by: #<n>, #<n>` line (iids). `blocking` is derived
  from every other ticket's `blockedBy`.
- **Map-ness is the `wayfinder:map` label** (same as GitHub).
- **State** — GitLab's `opened`/`reopened` both normalise to `open`; only
  `closed` is closed.
- **Identity is the project `iid`** (the `#42` you see in the UI), never the
  global `id`. It's the portable `Ticket.number`.

Epics/work-items and native `blocks`/`is_blocked_by` links are Premium+; the
adapter deliberately ignores them (see the `ponytail:` note in `gitlab.ts`).

## Writes

`claim`/`release` union/remove the token user's id in the issue's assignees
(GitLab replaces the whole list, so the adapter re-reads first). `close` posts
the accept comment as a note, then transitions the issue to `closed`. There is no
PR wiring (`openPR` omitted) — a Run's branch is left as an artifact.
