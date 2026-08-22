---
title: Conversations
description: Interactive, multi-turn Conversations with a Harness — how they differ from Tasks, and how in-conversation permissions work.
---

A **Conversation** is an interactive, multi-turn exchange the operator
drives with a Harness in a Working Directory over ACP. It is a first-class
sibling to Task, not a Task variant, with its own `conversations` /
`conversation_events` tables, its own driver (`ConversationDriver`), and its
own `active` → `ended` lifecycle.

## Why Conversation is not a Task variant

Per [ADR 0006](/harmonic/how-it-works/design-decisions/), a Conversation
participates in none of Task's defining machinery: it is never queued,
never picked by the Auto-Runner, never enters the review gate, has no
dependencies, and has no Isolation Mode. It is **direct-mode only**.
Worktree / Isolation Mode exists solely to produce a reviewable branch to
Accept or merge, and a Conversation has no Accept.

Harmonic reuses shared plumbing by extraction, not by overloading Task's
schema: the ACP driving loop, per-Turn Usage collection, and the
EventStream renderer. Conversation event payloads are byte-identical to
`run_events`, so rendering is shared by shape, not by inheritance.

| | Task | Conversation |
| --- | --- | --- |
| Queued / scheduled | Yes | No |
| Auto-Runner picks it up | Yes | No |
| Review gate | Yes | No |
| Isolation Mode | Worktree or direct | Direct-mode only |
| Dependencies | Yes | None |
| Permissions | Autonomous: auto-approve | Interactive: human-in-the-loop |
| Lifecycle | Task states (queued → running → awaiting-review → ...) | `active` → `ended` |

## Interactive permissions

Per [ADR 0007](/harmonic/how-it-works/design-decisions/), in a Conversation
the `ConversationDriver` holds the harness's ACP `session/request_permission`
request **open** and prompts the operator in the UI. The agent's turn
genuinely blocks on the human. This is the deliberate inverse of the Runner,
which auto-picks `allow_always` / `allow_once` so autonomous Runs never
wait.

Remembering a permission decision has three tiers:

| Tier | Scope | Persistence |
| --- | --- | --- |
| Allow once | This single request | Forgotten immediately |
| Allow for this conversation | Native ACP `allow_always` | Dies with the Conversation |
| Permission Rule | Tool **kind** + Working Directory | Persistent, opt-in |

A Permission Rule is auto-approval, a security escalation on par with the
`agentReview` flag, so it is opt-in (never the default click),
operator-visible, and revocable in Settings. See
[Settings & overrides](/harmonic/using-harmonic/settings-and-overrides/).

## In the UI

The Conversation is a docked panel on the right of the app shell, floating
over the board. The transcript is the content; telemetry is one whispered
line.
