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

Verification runs against the live worktree, including any work the agent
hasn't committed yet, and critics read that same working tree. Harmonic
only commits leftover changes after verification passes, right before the
merge. See [Branches & worktrees](/harmonic/work/branches-and-worktrees/)
for what that merge looks like.

To reuse a result elsewhere, such as in a tracker comment or a steer, hover
over it on the ticket page and click the copy icon. It's on a Critic's summary,
a verify command's result and its output, and each of the agent's messages.
Code blocks in Markdown have one too. Summaries and messages copy as Markdown,
and verify output copies in full, even when the page shows only part of it.

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

## When a merge is handed back

If a merge can't finish, Harmonic escalates the ticket and the merge progress
says why:

- **Merge conflict.** The work clashed with the base branch and the agent
  couldn't resolve it in its allowed turns.
- **Post-merge check failed.** A post-merge command went red after the merge.
  Harmonic reverts the merge and records the revert on the Timeline.
- **Base update failed.** Harmonic couldn't write the base branch, for example
  because another git process held its lock. Nothing in the work conflicted.
