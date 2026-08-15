---
title: Design decisions
---

Harmonic records significant architectural, tooling, and workflow decisions
as **Architecture Decision Records (ADRs)** in `docs/adr/` in the repo. Each
ADR is a short, standalone rationale. New architectural, tooling,
dependency, testing, CI, or workflow changes get an ADR before being
proposed.

The repo's ADRs have no formal status field — treat all of them as living,
accepted decisions unless a later ADR supersedes them. ADR 0001 carries
dated inline amendments.

## The ADRs

| #    | Decision |
| ---- | -------- |
| 0001 | [ACP is the only harness integration protocol](https://github.com/mintopia/harmonic/blob/main/docs/adr/0001-acp-only-harness-integration.md) |
| 0002 | [Accepting a review merges the run's branch (worktree mode)](https://github.com/mintopia/harmonic/blob/main/docs/adr/0002-accept-merges-worktree-branch.md) |
| 0003 | [Distribution is npx-from-GitHub, not an npm package](https://github.com/mintopia/harmonic/blob/main/docs/adr/0003-distribute-via-npx-from-github.md) |
| 0004 | [Drop the Config Repo](https://github.com/mintopia/harmonic/blob/main/docs/adr/0004-drop-the-config-repo.md) |
| 0005 | [OpenAPI is generated from zod route schemas](https://github.com/mintopia/harmonic/blob/main/docs/adr/0005-openapi-generated-from-zod-route-schemas.md) |
| 0006 | [Conversations are a first-class sibling to Task](https://github.com/mintopia/harmonic/blob/main/docs/adr/0006-conversations-are-a-first-class-sibling-to-task.md) |
| 0007 | [Interactive, human-in-the-loop permissions for Conversations](https://github.com/mintopia/harmonic/blob/main/docs/adr/0007-interactive-permissions-for-conversations.md) |
| 0008 | [Multiple Workspaces in a single instance](https://github.com/mintopia/harmonic/blob/main/docs/adr/0008-workspaces-in-a-single-instance.md) |
| 0009 | [Usage and hierarchy from native session-log parsing](https://github.com/mintopia/harmonic/blob/main/docs/adr/0009-usage-from-native-session-log-parsing.md) |
| 0010 | [Live, persisted Usage with Subagent roll-up](https://github.com/mintopia/harmonic/blob/main/docs/adr/0010-live-persisted-usage-with-subagent-rollup.md) |
| 0011 | [afk completion requires a resolved ticket](https://github.com/mintopia/harmonic/blob/main/docs/adr/0011-afk-completion-requires-a-resolved-ticket.md) |
| 0012 | [Per-workspace setting overrides with global-default inheritance](https://github.com/mintopia/harmonic/blob/main/docs/adr/0012-per-workspace-setting-overrides.md) |
| 0013 | [The documentation site is Astro Starlight, published to GitHub Pages](https://github.com/mintopia/harmonic/blob/main/docs/adr/0013-astro-starlight-for-the-docs-site.md) |
| 0014 | [Global tracker config removed; tracker mirroring stays per-Workspace](https://github.com/mintopia/harmonic/blob/main/docs/adr/0014-global-tracker-config-removed.md) |
| 0015 | [Dependency graph view: elkjs layered layout + hand-rolled SVG](https://github.com/mintopia/harmonic/blob/main/docs/adr/0015-dependency-graph-view-elkjs-svg.md) |
| 0016 | [Run SQLite migrations with foreign_keys disabled](https://github.com/mintopia/harmonic/blob/main/docs/adr/0016-migrations-run-with-foreign-keys-disabled.md) |
| 0017 | [Resolved Tracker is derived in-memory, not a persisted column](https://github.com/mintopia/harmonic/blob/main/docs/adr/0017-resolved-tracker-derived-in-memory.md) |
