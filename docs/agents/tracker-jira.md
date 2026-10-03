# Tracker adapter: Jira

A Workspace whose issues live in Jira (Cloud or Data Center). It talks to the
REST v2 API (`{baseUrl}/rest/api/2`) with plain-text bodies. Jira is selected
only as a Configured Tracker; it is never a Code Repository.

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

Scan reads issues in the project carrying any Triage Label (default vocabulary).
The issue key (`PROJ-123`) is the ticket ref. Native parent, `is blocked by` and
`blocks` links are read first, then `Part of PROJ-1` / `Blocked by: PROJ-2`
lines in the description. An `Epic` issue type counts as an Epic. Claim assigns
the token's user; release unassigns only if assigned to that user.

## Manual check against a Jira Cloud site

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens.
2. Store it as a Secret (for example `JIRA_TOKEN`).
3. Configure the Workspace tracker: kind `jira`, `baseUrl`, `authMode: cloud`,
   `email`, `projectKey`, `secretName: JIRA_TOKEN`.
4. Run Verify and confirm it reports ok (a wrong token shows the HTTP status).
5. On a throwaway issue labelled `ready-for-agent`, confirm it appears in a scan.
6. Claim it and confirm the assignee changes; release it and confirm it clears.
7. Close it with a comment and confirm the comment and the Done transition;
   reopen it and confirm it returns to a To Do-category status.
