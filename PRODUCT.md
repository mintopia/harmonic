# Product

## Register

product

## Platform

web

## Users

A developer-operator running their own fleet of autonomous coding agents from a Coder workspace — today that's the project author, but Harmonic is intended to be usable by other developers eventually. The typical context is a side monitor glanced at while coding: the board is scanned in seconds between other work, with occasional deep dives into a run's event stream. The primary job: keep a queue of agent tasks moving, and review what comes out before it lands.

## Product Purpose

Harmonic queues, executes, and reviews autonomous coding-agent Tasks by driving agent Harnesses (Claude, Codex, Copilot) over ACP. Success is **trustworthy autonomy**: agents run unattended, nothing merges without passing the review gate, and the operator rarely has to babysit — set tasks up, get notified, review, accept.

## Positioning

Run a fleet of coding agents unattended — nothing merges without your review — from one board that speaks to every harness over open ACP, with no vendor lock-in.

## Brand Personality

Fast, dense, operator-grade. Quiet control-room energy: the interface carries a lot of state in little space, speaks in one indigo accent (its only voice) over a small semantic state palette (amber running / green accepted / red failed / teal tooling) to mean things, and never performs excitement. The tool disappears into the task. (Accent updated 2026-07-15: the "Ledger" redesign made indigo the accent and amber a state color; see DESIGN.md.)

## Anti-references

- **CI/CD console gloom** — Jenkins/Grafana wall-of-widgets density; log-soup with no hierarchy. Dense is the goal, gloomy is not.
- **Chat-app cuteness** — playful agent avatars, emoji-heavy status, anthropomorphized agents.
- **Kanban-tool sprawl** — Jira/Trello feature creep: swimlanes, labels, and settings everywhere. The board stays a queue, not a project-management suite.

## Design Principles

1. **Glanceable state first.** The board must read from a side monitor in seconds. State is carried by position and the semantic color vocabulary, never by prose the operator has to read.
2. **The review gate is sacred.** Accept/Reject on awaiting-review work is the product's core promise; those affordances are never buried, ambiguous, or skippable by accident.
3. **Density without gloom.** Operator-grade information density with real hierarchy — muted layers stay readable (AA contrast floor), and every extra element must earn its space.
4. **Honest numbers.** Costs and usage never fake precision: incomplete aggregates show as floors (≥), unpriceable usage says so. Trust in the numbers is trust in the autonomy.
5. **Familiarity over novelty.** Standard affordances, one consistent component vocabulary, no decoration that doesn't convey state. Delight lives in speed and reliability.

## Accessibility & Inclusion

WCAG 2.1 AA: 4.5:1 contrast floor for informational text, full keyboard paths for all interactive elements, visible focus indication, `prefers-reduced-motion` alternatives for all animation. Dark is the canonical operator identity; a Daylight (light) variant ships for bright rooms, following `prefers-color-scheme` (amended 2026-07-14 with the DESIGN.md theme strategy, issue 19).
