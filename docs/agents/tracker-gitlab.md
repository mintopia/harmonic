# Tracker adapter: GitLab

A repo whose issues live on GitLab (gitlab.com or self-hosted). Harmonic drives
the ambient `glab` CLI, run inside the repo, so credentials and host come from
`glab`, not from Harmonic. There is no token setting and no Secret for GitLab.

## Auth and host

- Authenticate once on the machine running Harmonic: `glab auth login`
  (for a self-hosted instance, `glab auth login --hostname gitlab.example.com`).
- `glab` picks the host and credentials from the repo's `origin` remote. There
  is no `Host:` line and no `GITLAB_TOKEN` variable; neither is read.
- The token `glab` holds needs the `api` scope (the adapter reads issues and
  notes, and edits assignees, state and notes).

## Declaring it

Name it in `docs/agents/issue-tracker.md`:

```
# Issue tracker: GitLab

Project: group/repo
```

- **`Project:`** (optional) — `group/repo` or the numeric project id. When the
  line is absent the project is derived from the `origin` remote.

Or choose GitLab as the Workspace's Configured Tracker in the Workspace
settings (Integrations tab). Its one setting is **Project**, with the same
meaning and the same fallback to `origin`.

## What GitLab lacks (and how the adapter fills it)

The free tier has no native sub-issues or dependency links, so the adapter reads
the body-line conventions the GitHub doc prescribes as fallbacks, and
reverse-synthesises the `blocking` direction across the scan set, so the
normalised `Ticket` looks identical whatever the tracker:

- **Parent** — a `Part of #<n>` line in the issue description.
- **Blocking** — a `Blocked by: #<n>, #<n>` line (iids). `blocking` is derived
  from every other ticket's `blockedBy`.
- **Epics** — an issue titled `Epic: ...` or carrying the Epic Triage Label.
  Map-ness is the Wayfinder map label.
- **State** — `opened` and `reopened` both normalise to `open`; only `closed`
  is closed.
- **Identity is the project `iid`** (the `#42` you see in the UI), never the
  global `id`.

GitLab Epics, work items and native `blocks` / `is_blocked_by` links are
Premium and above; the adapter ignores them.

## Writes

`claim` / `release` add or remove the `glab` user in the issue's assignees
(GitLab replaces the whole list, so the adapter re-reads first). `close` posts
the accept comment as a note, then sets the issue `closed`. Opening MRs is the
Code Repository's job, not the tracker's. Choose GitLab (or Plain git, for a
host with no hosting API, which only pushes the branch) as the Workspace's Code
Repository in the Integrations settings; gitlab.com is detected automatically,
self-hosted GitLab needs the override.
