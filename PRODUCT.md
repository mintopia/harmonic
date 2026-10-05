# Product

## Platform

web

## Users

A developer-operator running their own fleet of autonomous coding agents from a Coder workspace. Today that is the project author; Harmonic is intended to be usable by other developers too. The board is usually on a side monitor, scanned between other work, with occasional deep dives into an Attempt's activity. The primary job is to keep Tasks moving unattended and resolve escalations when automation needs a decision.

## Product Purpose

Harmonic queues and executes autonomous coding-agent Tasks by driving Harnesses over ACP. Agents implement and commit, configured commands and Critics verify the work, and passing Tasks follow their Merge Fate: auto-merge, open a PR, or leave an artifact. Direct-mode Tasks complete in the live checkout. Human review is required for escalations, not for every successful Task.

Success is trustworthy autonomy. The operator sets up work, monitors progress, and intervenes when the bounded Attempt loop, a guardrail, or an infrastructure failure raises an escalation. Accept overrides the failed Step and advances the pipeline; Reject with guidance starts a fresh Attempt; Close ends the Task. These actions must explain their effect before the operator acts. The execution ADRs govern the precise behavior, including the verify-once merge tradeoff in ADR-0040.

## Positioning

Run a fleet of coding agents unattended from one board over open ACP. Verification drives completion; escalations bring the decisions that need you.

## Brand Personality

Fast, dense, operator-grade. The interface carries substantial state in little space and keeps attention on the work. The **Paper** design uses neutral graphite grounds in dark mode and warm paper in light mode, with color reserved for actions and state.

Teal is the action and tooling accent. Indigo marks escalations that need the operator. Ready uses azure, running uses amber, merged uses emerald, failed Attempts use rose, and blocked work uses slate. Failure belongs to an Attempt; a Task retries or escalates. Color always has a text or accessible label.

`DESIGN.md` defines the current visual system, and `web/src/index.css` is the authority for its tokens. Both themes and both densities must preserve that vocabulary.

## Anti-references

- **CI/CD console gloom** — Jenkins/Grafana wall-of-widgets density; log-soup with no hierarchy. Dense is the goal, gloomy is not.
- **Chat-app cuteness** — playful agent avatars, emoji-heavy status, anthropomorphized agents.
- **Kanban-tool sprawl** — Jira/Trello feature creep: swimlanes, labels, and settings everywhere. The board stays a queue, not a project-management suite.

## Design Principles

1. **Glanceable state first.** The board must read from a side monitor in seconds. State is carried by position and the semantic color vocabulary, never by prose the operator has to read.
2. **Escalations need clear decisions.** Put work that needs the operator first. Accept, Reject with guidance, and Close must be easy to find, explain their consequences, and remain restricted to the operator.
3. **Density without gloom.** Operator-grade information density with real hierarchy — muted layers stay readable (AA contrast floor), and every extra element must earn its space.
4. **Honest numbers.** Costs and usage never fake precision: incomplete aggregates show as floors (≥), unpriceable usage says so. Trust in the numbers is trust in the autonomy.
5. **Familiarity over novelty.** Use standard affordances and one consistent component vocabulary. Decoration must convey state.
6. **Recover without losing work.** Preserve drafts after failed requests or accidental dismissal. Loading failures offer a retry, partial saves say what succeeded, and workspace changes never display stale data from another workspace.

## Accessibility & Inclusion

WCAG 2.1 AA: 4.5:1 contrast floor for informational text, full keyboard paths for all interactive elements, visible focus indication, `prefers-reduced-motion` alternatives for all animation. Dark is the canonical operator identity; a Daylight (light) variant ships for bright rooms, following `prefers-color-scheme` (amended 2026-07-14 with the DESIGN.md theme strategy, issue 19).
