---
title: Design decisions
---

Harmonic records architectural, tooling, and workflow decisions as
**Architecture Decision Records (ADRs)** in `docs/adr/` in the repo. Each ADR
is a short, standalone rationale. New architectural, tooling, dependency,
testing, CI, or workflow changes get an ADR before being proposed.

:::note[The 2026-08-28 ADR reset]
On 2026-08-28 the accumulated 49-ADR trail was replaced by **12 definitive
target-state ADRs**, renumbered 0001–0012. Numbers below refer to the new
set; any older link, document, or commit citing an ADR number from before the
reset refers to the **pre-reset set**, preserved at git tag
[`adr-reset-2026-08-28`](https://github.com/mintopia/harmonic/tree/adr-reset-2026-08-28/docs/adr)
with a full old→new mapping in
[`docs/adr/README.md`](https://github.com/mintopia/harmonic/blob/main/docs/adr/README.md).
The new ADRs describe the decided target state; where not-yet-migrated code
disagrees, the ADRs win.
:::

## The ADRs

| #    | Decision |
| ---- | -------- |
| 0001 | [Execution model: verify the branch, merge with a merge commit](https://github.com/mintopia/harmonic/blob/main/docs/adr/0001-execution-model-one-merge-policy.md) |
| 0002 | [Guardrails, branch ownership, and the escalation surface](https://github.com/mintopia/harmonic/blob/main/docs/adr/0002-guardrails-branch-ownership-escalation.md) |
| 0003 | [Verification and the critic](https://github.com/mintopia/harmonic/blob/main/docs/adr/0003-verification-and-the-critic.md) |
| 0004 | [Tracker mirroring and ticket sourcing](https://github.com/mintopia/harmonic/blob/main/docs/adr/0004-tracker-mirroring-and-ticket-sourcing.md) |
| 0005 | [Harness integration over ACP, Sessions, and steering](https://github.com/mintopia/harmonic/blob/main/docs/adr/0005-acp-harness-sessions-and-steering.md) |
| 0006 | [Conversations and interactive permissions](https://github.com/mintopia/harmonic/blob/main/docs/adr/0006-conversations-and-interactive-permissions.md) |
| 0007 | [Persistence, the database, and event-loop discipline](https://github.com/mintopia/harmonic/blob/main/docs/adr/0007-persistence-database-event-loop.md) |
| 0008 | [Usage, Cost, and Stats metrics](https://github.com/mintopia/harmonic/blob/main/docs/adr/0008-usage-cost-and-stats.md) |
| 0009 | [Instance, Workspaces, settings and configuration](https://github.com/mintopia/harmonic/blob/main/docs/adr/0009-instance-workspaces-and-settings.md) |
| 0010 | [Observability: Operations and Scheduled Jobs](https://github.com/mintopia/harmonic/blob/main/docs/adr/0010-observability-operations-and-scheduled-jobs.md) |
| 0011 | [Web UI and API conventions](https://github.com/mintopia/harmonic/blob/main/docs/adr/0011-web-ui-and-api-conventions.md) |
| 0012 | [Distribution, tooling, and the docs site](https://github.com/mintopia/harmonic/blob/main/docs/adr/0012-distribution-tooling-and-docs-site.md) |
