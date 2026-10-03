# Decision: Tracker selection, Code Repository, and Secrets

Status: accepted
Date: 2026-10-03

## Context

Harmonic mirrors tickets from one issue tracker per Workspace. Until now the
tracker was named only by the repo's `docs/agents/issue-tracker.md`
(GitHub, GitLab, Local Markdown), resolved at poll time, with no way for an
operator to choose differently. Credentials were never stored: GitHub and
GitLab ride on ambient `gh` / `glab` auth. Tracker refs are integer columns
in four tables. Opening a PR is a method on the tracker interface, and only
GitHub implements it.

Two new trackers break every one of those assumptions. Forgejo is self-hosted
on any domain and has no ambient CLI. Jira hosts no git, keys issues as
`PROJ-123`, has transitions instead of close, and needs a token per site. A
repo declaration cannot express "issues in Jira, code on GitHub", and a
Workspace cannot be pointed at a tracker the repo does not declare.

## Decision

**Two seams, two concepts.** A Workspace has a **Resolved Tracker** (where
tickets come from) and a **Code Repository** (where branches, PRs/MRs and
Merges go). They are independent: Jira + GitHub, Jira + Forgejo, Forgejo +
Forgejo are all representable. `openPR` leaves the tracker interface and
lives on a `RepositoryAdapter` (GitHub, GitLab, Forgejo). The Code Repository
is detected from the `origin` remote (github.com, gitlab.com, otherwise a
Forgejo host that answers its version endpoint) and is overridable per
Workspace.

**Resolution precedence.** Configured Tracker (the Workspace's explicit
setting) → Detected Tracker (the repo's `issue-tracker.md`) → the Code
Repository when it is also an issue tracker → none. The explicit setting
always wins; the UI shows which source won. This replaces ADR-0004's
"declared by the repo, never auto-detected" clause. Triage Labels resolve in
the same shape: Workspace setting → the repo's `triage-labels.md` role table
→ instance defaults.

**Tracker kinds are modules behind one registry.** Each kind is one module
exporting a `TrackerKind`: id and label, a zod settings schema (non-secret
fields plus the Secret names it needs), a declared capability set, and a
factory returning a `TrackerAdapter`. The kinds list is the only enumeration;
resolution, the ADR-0009 settings registry, the Workspace settings UI,
Verify, and ADR-0004 capability gating derive from the definition. A shared
conformance test runs the same scenarios against every kind through an
injected HTTP client. Adding a tracker is one module and one list entry.

**Tracker refs are opaque strings.** The four integer `tracker_ref` columns
become text. Harmonic never parses, orders, or formats a ref; the owning
adapter renders it (`#185`, `PROJ-185`).

**Secrets.** A `secrets` table holds per-Workspace named credentials,
AES-256-GCM encrypted with an instance key. The key is a `0600` file
generated at first boot in the data directory (ADR-0041 layout, so it
survives self-upgrade), overridable by `HARMONIC_SECRET_KEY`. Secrets are
write-only through the API and UI: set / not set, replace, clear. Non-secret
tracker settings stay in `settings.yaml` per ADR-0009. GitHub and GitLab keep
ambient CLI auth for now; moving them to stored Secrets is a later decision.

**Jira specifics.** REST v2 on both Cloud (email + API token) and Data Center
(bearer PAT), so bodies are text and there is no ADF converter. Scope is a
project key plus optional extra JQL. Close and reopen are transitions:
configured status names, else the first transition into the Done / To Do
status category. An optional on-pickup transition is a setting.

**Forgejo specifics.** Full parity with GitHub: scan, claim, release, close,
reopen, native dependencies, PRs. Epics come from one of two configurable
sources: `epic`-labelled issues (default) or Milestones (see Amendment).

**Relationships.** Every adapter reads native parent / blocked-by first and
the body-line convention second, through one shared parser. GitLab's native
links are out of scope until a testable instance exists.

## Consequences

- Operators can point any Workspace at any supported tracker, and the common
  GitHub-remote repo needs no declaration file at all.
- The `tracker_ref` migration touches `tasks`, `tracker_dismissals`,
  `tracker_containers`, their unique index, and every place that typed refs
  as numbers. `/implement <ref>` takes a string.
- Harmonic now holds credentials. Losing the key file means re-entering
  tokens; the DB alone never yields them. Backups must include the key file
  to be restorable.
- Two seams instead of one: a Workspace page shows an Issue tracker section
  and a Code repository section, each with its own override and Verify.
- Alternatives rejected: env-var credentials (per-instance, not per-Workspace;
  two Jira sites on one instance is realistic); plaintext tokens in
  `settings.yaml` (on disk, in backups); Jira v3 with an ADF converter (a
  second code path for no behaviour); a single "tracker" setting where Jira
  implies a detected code host (not representable, not explainable in UI).

## Supersedes

None. Amends ADR-0004 (resolution clause) and ADR-0009 (adds schema-derived
tracker settings and the Secrets store).

## Amendment (2026-10-03): Forgejo has no Projects source

The original decision allowed repo Projects as a third Forgejo Epic source,
covered only by fixtures. A live check against Forgejo 16.0.5 (API reports
Gitea 1.22.0) returned 404 for `/repos/{owner}/{repo}/projects`, while
Milestones and issues respond normally. Forgejo's API has no Projects
endpoints, so the `project` Epic source is removed. Forgejo Epics come from
`epic`-labelled issues or Milestones only. Issue #777.
