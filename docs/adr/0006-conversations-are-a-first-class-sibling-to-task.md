# Conversations are a first-class sibling to Task

A **Conversation** is an interactive, multi-turn exchange the operator drives
with a Harness in a Working Directory over ACP. It is modelled as its own
concept alongside Task, with its own `conversations` / `conversation_events`
tables, its own driver, and its own `active` → `ended` lifecycle. It is not
a Task variant.

We chose this over reusing `tasks`/`runs` with a `kind: 'chat'`
discriminator because a Conversation participates in *none* of Task's
defining machinery: it is never queued, never picked by the Auto-Runner,
never enters the review gate, and has no Isolation Mode (worktree exists only
to produce a reviewable branch, and Conversations have no Accept to merge
it). Threading "except when chat" exceptions through the scheduler, the
review gate, dependencies, and the board would erode Task's model, the
product's core promise, to save schema. Instead the genuinely shared
plumbing is reused by extraction: the ACP driving loop, per-Turn Usage
collection, and the `EventStream` renderer (Conversation event payloads are
byte-identical to `run_events`, so rendering is shared by *shape*, not table).

## Consequences

- A second execution path (`ConversationDriver`) exists beside `Runner`.
  Shared ACP/Usage logic must be extracted rather than duplicated as it grows.
- `runs` keeps its exact CONTEXT.md meaning ("one execution attempt of a
  Task, one prompt turn"); no query needs to say "…and not a conversation."
- Conversations are **direct-mode only**. Isolation Mode is deliberately
  absent, a review-gate concept with no home here.
