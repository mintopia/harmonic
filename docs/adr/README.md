# Harmonic architecture decisions

The current set contains **46 ADRs**, reconciled on **2026-10-03**. They record
accepted decisions, their rationale, and explicit amendments. A Context section
may describe a historical defect; it does not by itself identify an open issue.
Current-status notes and the operative Decision sections describe the current
contract. Later ADRs override only the clauses they identify.

The ADR-0001 execution teardown shipped in
[epic #390](https://github.com/mintopia/harmonic/issues/390), closed 2026-08-29.
The architecture-remediation epics
[#444](https://github.com/mintopia/harmonic/issues/444) and
[#460](https://github.com/mintopia/harmonic/issues/460), and code-quality epic
[#647](https://github.com/mintopia/harmonic/issues/647), are also complete.
Their review grades and original task lists are historical, not a remaining
architecture backlog.

This reconciliation closes the identified implementation gaps: Epic
post-merge commands share the administrative merge worktree, Stats accumulates
measured agent-turn time and computes aggregates in its worker, and startup no
longer runs the pre-Workspace configuration/association backfill. Historical
Attempts without timing measurements retain the documented wall-clock fallback.

## Reading amended decisions

| Topic | Foundation | Current amendments |
|---|---|---|
| Execution and escalation | 0001, 0002, 0005 | 0020 transition rules; 0027 pause/resume; 0038 step-aware Accept and fresh-Attempt Reject |
| Merge placement and publication | 0001 | 0039 administrative worktrees and base synchronization; 0040 reconciliation and atomic publication |
| Epics | 0004, 0015, 0016 | 0017 summary page; 0018 stored identity; 0023 structural roots; 0028 Epic Attempts; 0039 all-direct completion |
| Verification | 0003 | 0028 stage lists; 0031 ordering; 0037 additive overlays; 0038 Step overrides; 0039 post-merge checkout |
| Configuration and harnesses | 0009 | 0022 baseline/global/workspace layering; 0025 OpenCode; 0036 unattended permission modes; 0037 verifier overlays; 0046 tracker selection, Code Repository, Secrets (amended 2026-10-03: private-host probes; generic git Code Repository) |
| Conversations and navigation | 0006, 0011 | 0026 read-only Activity; 0029 transcript view; 0033 scoped routes; 0035 eager command discovery |
| Persistence and evidence | 0007, 0008 | 0014 fleet Stats; 0042 managed-upgrade snapshots; 0044 Task Archives and Exports (amended 2026-10-03: `agent-messages.json` in Export bundles); 0045 Agent Messages |
| Distribution and operation | 0010, 0012 | 0013 releases; 0024 worktree controls; 0030 updates; 0034 services; 0041 atomic installs; 0042 install modes and rollback; 0043 toolchain |

## Reset archive

On 2026-08-28 the previous 49-document set was replaced by the first 12 ADRs
in this directory. Subsequent decisions extended the set to its current size.
The old documents and reset review records remain at git tag
`adr-reset-2026-08-28` (commit `1411730a8043`). A pre-reset ADR citation resolves
there, never to a same-numbered document in the current set. The mapping below
is historical and retains the terminology used at the reset.

## Current decision index

| # | ADR |
|---|---|
| 0001 | [Execution model: one merge policy](0001-execution-model-one-merge-policy.md) |
| 0002 | [Guardrails, branch ownership, escalation](0002-guardrails-branch-ownership-escalation.md) |
| 0003 | [Verification and the critic](0003-verification-and-the-critic.md) |
| 0004 | [Tracker mirroring and ticket sourcing](0004-tracker-mirroring-and-ticket-sourcing.md) |
| 0005 | [ACP harness, Sessions, and steering](0005-acp-harness-sessions-and-steering.md) |
| 0006 | [Conversations and interactive permissions](0006-conversations-and-interactive-permissions.md) |
| 0007 | [Persistence, database, event loop](0007-persistence-database-event-loop.md) |
| 0008 | [Usage, Cost, and Stats](0008-usage-cost-and-stats.md) |
| 0009 | [Instance, Workspaces, and settings](0009-instance-workspaces-and-settings.md) |
| 0010 | [Observability: Operations and Scheduled Jobs](0010-observability-operations-and-scheduled-jobs.md) |
| 0011 | [Web UI and API conventions](0011-web-ui-and-api-conventions.md) |
| 0012 | [Distribution, tooling, and docs site](0012-distribution-tooling-and-docs-site.md) |
| 0013 | [Release automation: release-please](0013-release-automation-release-please.md) |
| 0014 | [Enriched fleet Stats: task-grain aggregates and colour encoding](0014-enriched-fleet-stats.md) |
| 0015 | [Epic summary page](0015-epic-summary-page.md) |
| 0016 | [Epics are label-driven containers, not work tasks](0016-epics-are-containers.md) |
| 0017 | [The Epic summary page replaces the board's epic-focus surface](0017-epic-summary-page-replaces-board-focus.md) |
| 0018 | [Epics are first-class stored resources](0018-epics-are-first-class-stored-resources.md) |
| 0019 | [Code & architecture review remediation](0019-code-and-architecture-review-remediation.md) |
| 0020 | [Task lifecycle state machine](0020-task-lifecycle-state-machine.md) |
| 0021 | [Second code, architecture & product review remediation](0021-second-review-remediation.md) |
| 0022 | [Configuration layering, modified state, and the per-harness model catalog](0022-configuration-layering-and-model-catalog.md) |
| 0023 | [A root ticket with children is a structural Epic, no label required](0023-structural-root-epics.md) |
| 0024 | [Operations is a worktree control surface: inventory, force-cleanup, reconcile-on-demand](0024-operations-worktree-control-surface.md) |
| 0025 | [The OpenCode harness and dynamic harness capabilities](0025-opencode-harness-and-dynamic-capabilities.md) |
| 0026 | [Activity is strictly a read-only agent glance](0026-activity-strictly-read-only-agent-glance.md) |
| 0027 | [Pause and resume: an operator execution freeze and one unified warm/cold resume](0027-pause-and-resume.md) |
| 0028 | [Epic-as-workable and staged Verification](0028-epic-as-workable-and-staged-verification.md) |
| 0029 | [Conversations as a first-class view with rich transcript rendering](0029-conversations-first-class-view-and-rich-transcript.md) |
| 0030 | [In-place self-upgrade for packaged instances](0030-in-place-self-upgrade.md) |
| 0031 | [Reorderable, named verifier lists with @dnd-kit](0031-reorderable-verifier-lists-with-dnd-kit.md) |
| 0032 | [Files: in-app file browser, editor, and basic git](0032-files-in-app-browser-editor-and-basic-git.md) |
| 0033 | [Global scope and path-based routing](0033-global-scope-and-path-routing.md) |
| 0034 | [Running Harmonic as a supervised service](0034-running-harmonic-as-a-supervised-service.md) |
| 0035 | [Slash-command autocomplete in the Conversation Composer](0035-slash-command-autocomplete-in-the-composer.md) |
| 0036 | [Per-Harness unattended permission mode for Attempts](0036-per-harness-permission-mode-for-attempts.md) |
| 0037 | [Additive, id-keyed workspace verifier overlays](0037-additive-workspace-verifier-overlays.md) |
| 0038 | [Step-aware escalation actions: Reject spawns a fresh Attempt, Accept advances the pipeline](0038-step-aware-escalation-actions.md) |
| 0039 | [Epic integration and branch retirement use an ephemeral worktree](0039-epic-integration-and-retirement-use-an-ephemeral-worktree.md) |
| 0040 | [The merge reconciles base movement by re-merging, not by a SHA assertion](0040-merge-reconciles-base-movement-without-a-sha-assertion.md) |
| 0041 | [Non-privileged atomic self-upgrade](0041-non-privileged-atomic-self-upgrade.md) |
| 0042 | [Upgrade install modes, boot guard, and rollback](0042-upgrade-install-modes-boot-guard-and-rollback.md) |
| 0043 | [Supported Node and npm versions](0043-supported-node-and-npm-versions.md) |
| 0044 | [Every Task keeps a file Archive, exported on terminal disposition](0044-task-archive-and-export.md) |
| 0045 | [Agent Messages travel over Harmonic's MCP server with A2A-shaped payloads](0045-agent-messages-over-mcp-with-a2a-shaped-payloads.md) |
| 0046 | [Tracker selection, Code Repository, and Secrets](0046-tracker-selection-code-repository-and-secrets.md) |

## Where every pre-reset ADR went

One row per old ADR where it maps whole; clause rows where an ADR was partial
or split across destinations. "Dropped" decisions are gone by owner decision,
not omission. Old numbers below always refer to the **pre-reset** set (the
tag); new numbers are this directory.

| Old | Disposition |
|---|---|
| 0001 ACP-only | → new 0005, whole |
| 0002 accept-merges-branch | dead (review gate deleted); its merge-on-success intent restated in new 0001 |
| 0003 npx-from-GitHub | superseded → new 0012 (npm package, owner decision) |
| 0004 drop config repo | → new 0007 + 0009 (DB sole home of config) |
| 0005 OpenAPI from zod | → new 0011, whole |
| 0006 Conversations first-class | → new 0006, whole |
| 0007 interactive permissions | → new 0006, whole |
| 0008 Workspaces in one instance | → new 0009, whole |
| 0009 usage from native logs | split: collection mechanism → new 0005; parsing/metric semantics → new 0008 |
| 0010 live persisted usage | → new 0008 (kept as-is); its "Cost never stored" clause superseded by 0035 |
| 0011 closure-as-success | dead (superseded pre-reset by 0021/0041); "closure is an output" → new 0004 |
| 0012 per-workspace overrides | split: resolution model, cap, master switch, chat defaults → new 0009; three-scope split superseded by 0044 → new 0009 |
| 0013 Starlight docs site | → new 0012, whole |
| 0014 tracker config workspace-only | → new 0004 (backfill shim noted removable) |
| 0015 graph view elkjs+SVG | → new 0011, whole |
| 0016 migrations FK-off | → new 0007 (reworded for libsql) |
| 0017 resolved tracker in-memory | → new 0004 (tension with 0030 recorded as settled) |
| 0018 steer a running task | → new 0005, whole (seven clauses enumerated) |
| 0019 guardrails trip to escalation | split: core → new 0002; v5-reconciliation section dropped (execution chains, phase-scoped budgets) |
| 0020 Sessions first-class | split: core (entity, `session/load`, warmth-as-cost, compatibility matrix, MCP templates, replay quarantine) → new 0005; keepalive, reattach, hardcoded window, reliability-design refs dropped |
| 0021 verification gate | split: core + tool-enabled-critic amendment → new 0003 (re-based: in-place, instruction-restrained, both revisions); v5 frozen-candidate pipeline dropped; merge-cleanliness amendment dropped (owner decision) |
| 0022 one run per work context | split: original scheduler predicate → new 0001; durable-lease reconciliation dropped |
| 0023 Harmonic owns branching | split: contract + detection + guardrail → new 0002; v5 reconciliation and clean-lease amendment dropped with the old integration path |
| 0024 epic integration + merge train | split: integration branch, `baseBranch`, whole-Epic gate, Epic derivation → new 0001 + 0004; merge train dropped; containment amendment reduced to the ancestor check (new 0001) + bounded-loop principle (new 0007) |
| 0025 hard-delete / dismiss | → new 0004 (four guarantees spelled out; cascade re-based to post-reset schema) |
| 0026 parallel-epic UI | split: board-hosted model + derived read endpoint → new 0011; Epic Peek, merge-train hero, force-merge rail replaced by the owner-designed Epic presentation (new 0011) |
| 0027 escalation escape hatches | dead (superseded pre-reset by 0041); the three-action surface → new 0002 |
| 0028 stats metric definitions | → new 0008, re-based to Attempt grain (duration = agent time only; rejection is a failed Attempt — owner decisions) |
| 0029 async libsql single-writer | split: driver, queue, atomicity, timeouts, monitor, yield rule → new 0007; "async ⇒ off-loop" claim struck (0036); lease-sweep examples dead |
| 0030 local DB source of truth | split: derivation, eligibility, claim, scheduling, priority, status, skip reasons, reclaim → new 0004; persistence principle → new 0007 |
| 0031 tool aggregates, JSONL on demand | → new 0007, whole |
| 0032 held permissions for autonomous runs | dropped (never built; owner decision) — noted in new 0006 |
| 0033 running-amber sub-AA exception | → new 0011, whole |
| 0034 migrate web app to Paper | split: Paper commitment, contrast gate, merged/merging vocabulary → new 0011; the eight-child migration sequence is spent, dropped |
| 0035 cost computed once and stored | → new 0008, whole |
| 0036 libsql inline; heavy reads off-thread | → new 0007, whole |
| 0037 Operations as OTel spans | → new 0010, whole (span names re-vocabularied; exhaustive-logging doctrine strengthened, owner decision) |
| 0038 Scheduled Jobs | split: Scheduler, registry, read surface → new 0010; job roster rewritten (lease + review-SLA sweeps retired with named dispositions) |
| 0039 oxlint | → new 0012, whole |
| 0040 critic transcript locator | → new 0003, whole |
| 0041 unified ticket lifecycle | split: vocabulary, states, Attempt loop, continuation rule, tracker-as-output, config keys, board/ticket visibility → new 0001/0004/0005/0011; escalation surface → new 0002; freshness gate, SHA-asserted merging, Rebase Task, merge-train reliance dropped |
| 0042 verification visible + timeline | split: Decisions A (verifier statuses incl. `planned`) and C (subagent attribution) → new 0003; Decision B (lifecycle timeline) → new 0011 (source list re-based) |
| 0043 operator-accept auto-rebase | dead — no path re-verifies on base movement; Accept runs the one merge policy (new 0001) |
| 0044 unified settings schema | split: schema, three-state inheritance, decomposition, list-grain commands, reclassification, one engine → new 0009; Decision F (validate resolved, loud unrunnable) → new 0003 + 0009 |
| 0045 lean paginated lists | → new 0011, whole |
| 0046 deterministic base-branch integration | superseded by the one merge policy; surviving parts (direct-in-place, per-Task worktree, quiet epic refresh, no forensic guards, merge/integrate vocabulary) → new 0001 |
| 0047 Run and Attempt coexist | dead — Run collapses into Attempt (new 0001), the narrowing 0047 itself anticipated |
| 0048 reject requeues | → new 0002, whole, including the warm-Session "start now" override and its rationale |
| 0049 execution model, one merge policy | renumbered → new 0001, with the scope clarification (per-Workspace-repository mutex, Task/Ticket ownership, Step, warm-Session exception deferring to new 0002) |

## Conventions

New ADRs are numbered sequentially from 0013. Format per the repo's ADR
template (Title, Status, Date, Context, Decision, Consequences, Supersedes).
The banned merge synonym from the pre-reset vocabulary purge stays banned in
all new decision text.
