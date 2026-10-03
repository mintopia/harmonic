# Tracker adapter: Forgejo

A repo whose issues live on a Forgejo (or Gitea-compatible) instance. Harmonic
talks to the REST API at `{baseUrl}/api/v1` with a token held as a Secret.
Forgejo can also be the Workspace's Code Repository; the two are chosen
independently.

## Declaring it

Name it in `docs/agents/issue-tracker.md`:

```
# Issue tracker: Forgejo

Base URL: https://forge.example
Repo: owner/name
```

- **`Base URL:`** and **`Repo:`** are both optional. A missing one is read from
  the `origin` remote (`https://forge.example/owner/name.git` gives both).
- The token is never in the repo doc; it is a Secret (below).

## Settings

Workspace settings, Integrations tab, Configured Tracker = Forgejo.

| Setting | Required | Meaning |
| --- | --- | --- |
| `baseUrl` | yes | Instance root, e.g. `https://forge.example`. |
| `repo` | yes | `owner/name`. |
| `tokenSecret` | no | Name of the Secret holding the token. Default `FORGEJO_TOKEN`. |
| `epicSource` | no | Where Epics come from: `label` (default) or `milestone`. |

The Workspace settings page shows a **Secret** row for `FORGEJO_TOKEN` with
Set / Replace / Clear. The value is write-only and applies immediately, without
the save bar. If you change `tokenSecret`, the Secret to set is the one you named.

## Token scopes

Create a personal access token in Forgejo (Settings, Applications) with:

- `read:user` (identifies who claims issues)
- `write:issue` (read and edit issues, labels, assignees, comments, milestones)
- `read:repository` (read the repo and its Milestones)

`write:issue` is what claim, release, close and reopen need. Without it a scan
works but Task writes fail with HTTP 403.

## Reading tickets

Scan lists the repo's issues (pull requests are skipped). Dependencies come from
Forgejo's native "blocked by" links first, then `Blocked by: #2, #3` lines in
the body.

## Epic sources

- **`label`** — an issue carrying the Epic Triage Label is an Epic; a
  `Part of #<n>` body line makes an issue its child.
- **`milestone`** — each open Milestone is an Epic; its issues are its children.

Closing a Milestone Epic sets that Milestone `closed`; reopening sets
it `open`.

Forgejo's API has no Projects endpoints (checked against Forgejo 16.0.5, whose
API reports Gitea 1.22.0: `/repos/{owner}/{repo}/projects` returns 404), so
Projects are not an Epic source.

## Writes

`claim` assigns the token's user; `release` unassigns only that user. `close`
posts the accept comment, then sets the issue `closed`; `reopen` sets it `open`.
There are no workflow transitions.
