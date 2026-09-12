---
title: Reviewing & merging
description: What stands between an agent's work and your main branch — the reviews a change passes and how it gets merged.
---

An agent's work doesn't reach your main branch unchecked. What checks it,
and how it merges, depends on whether the ticket ran on its own or you
queued it by hand.

## Tickets that run themselves

For a ticket that's ready for an agent, the review is built into the work.
The agent implements the change and reviews it as part of the same job,
running its own `/code-review` before it calls the ticket done. If that
review fails, or the agent finishes without actually resolving the ticket,
Harmonic doesn't merge, it runs a fresh attempt up to a set limit, then
hands the ticket back to you. Only work the agent stands behind gets to the
merge step.

When it passes, Harmonic merges it for you. What "merge" means is set by
the ticket's **merge fate**:

| Merge fate | What happens |
| --- | --- |
| **Merge** (default) | Merge the branch into its base branch, ticket done. A conflict is handed back to you rather than forced. |
| **Open a PR** | Push the branch and open a pull request instead, so a merge happens off Harmonic, on your usual PR flow. |
| **Leave the branch** | Do nothing automatic, the branch is left for you or CI to pick up. Research findings always use this. |

You set the default merge fate globally and can override it per ticket. It
applies when a ticket runs on its own branch, which is where there's
something to merge.

### An optional extra check

If your own `/code-review` isn't enough assurance, Harmonic can run its own
**verification** before the merge: any number of commands (like your test
suite) and named AI critics that read the change against the ticket, run in
the order you set. It's off until you configure it, and when on it's an
additional gate: the change merges only if every check passes. Set it up in
[Settings & overrides](/harmonic/run/settings/).

## Tickets you queue by hand

A one-off task you create yourself works differently: it stops for **you**.
When the agent finishes, the task waits for your decision, nothing merges
until you make it:

- **Accept** it, and Harmonic completes the task, merging the branch into
  its base (a conflict sends it back for you to sort out).
- **Reject** it, and the task fails; you can send it back for another
  attempt, with feedback attached if you want to steer the next try.

This hand-review step is the one place a human signs off inside the flow,
and it's there because you asked for the work directly. Tickets from your
tracker skip it, closing the ticket is their sign-off.
