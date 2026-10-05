# Tracker adapter: Jira

A Workspace whose issues live in Jira (Cloud or Data Center). It talks to the
REST v2 API (`{baseUrl}/rest/api/2`) with plain-text bodies. Jira is selected
only as a Configured Tracker; it is never a Code Repository.

## Declaring it

There is no declaration line. A repo's `docs/agents/issue-tracker.md` cannot
select Jira (there is no `Project:` or `Base URL:` form to read). Choose it in
the Workspace settings, Integrations tab, Configured Tracker = Jira. The code
for the Workspace is hosted elsewhere (GitHub, GitLab or Forgejo) and is set
separately as the Code Repository.

## Settings

| Setting | Required | Meaning |
| --- | --- | --- |
| `baseUrl` | yes | Site URL, e.g. `https://acme.atlassian.net` (trailing slash trimmed). |
| `authMode` | yes | `cloud` (Basic `email:token`) or `datacenter` (Bearer PAT). |
| `email` | cloud only | Account email paired with the API token. |
| `projectKey` | yes | Jira project key, e.g. `PROJ`. |
| `extraJql` | no | Extra clause ANDed onto the scan query. |
| `pickupStatus` | no | Status name to transition to when a Task claims the issue. |
| `doneStatus` | no | Status name used on close; else the first `done`-category transition. |
| `reopenStatus` | no | Status name used on reopen; else the first `new`-category transition. |
| `secretName` | yes | Name of the Secret holding the API token or PAT. |

## Token and permissions

- **Jira Cloud** — an API token from
  https://id.atlassian.com/manage-profile/security/api-tokens, used with the
  account `email` (`authMode: cloud`).
- **Data Center** — a Personal Access Token (`authMode: datacenter`), sent as a
  Bearer token.

The account behind the token needs, on the project: Browse Projects, Edit
Issues, Assign Issues, Transition Issues and Add Comments. Jira has no token
scopes in the Forgejo sense; access is whatever that account can do.

The Secret named by `secretName` holds the token. The Workspace settings page
lists a Secret row only for tracker kinds with a fixed Secret name, so for Jira
set the value through the API instead:

```
PUT /workspaces/<workspace-id>/secrets/<secretName>
```

with the JSON body `{"value": "<token>"}` (see the API reference under
Secrets). Values are write-only and never returned.

## Reading tickets

Scan reads issues in the project carrying any Triage Label (default
vocabulary), ANDed with `extraJql` when set. The issue key (`PROJ-123`) is the
ticket ref. Native parent, `is blocked by` and `blocks` links are read first,
then `Part of PROJ-1` / `Blocked by: PROJ-2` lines in the description.

## Epic source

An issue of type `Epic` is an Epic. There is no other source.

## Transitions

Jira closes by workflow transition, not a state flag.

- **Claim** assigns the token's user. If `pickupStatus` is set and a transition
  to that status exists, it is taken; a failed pickup transition is logged and
  does not fail the claim.
- **Release** unassigns only if the issue is assigned to the token's user.
- **Close** posts the comment, then takes the transition to `doneStatus`, else
  the first transition into a `done`-category status.
- **Reopen** posts the comment, then takes the transition to `reopenStatus`,
  else the first transition into a `new`-category (To Do) status.

Status names are matched case-insensitively against what the issue's workflow
offers. If no matching transition exists the close or reopen fails with an
error naming the available transitions.

## Manual check against a Jira Cloud site

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens.
2. Store it as a Secret (for example `JIRA_TOKEN`) through the API, as above.
3. Configure the Workspace tracker: kind `jira`, `baseUrl`, `authMode: cloud`,
   `email`, `projectKey`, `secretName: JIRA_TOKEN`.
4. On a throwaway issue labelled `ready-for-agent`, confirm it appears in a scan.
5. Claim it and confirm the assignee changes; release it and confirm it clears.
6. Close it with a comment and confirm the comment and the Done transition;
   reopen it and confirm it returns to a To Do-category status.
