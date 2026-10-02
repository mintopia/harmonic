---
title: Reviewing & merging
description: Configure verification commands and Critics, and choose how successful work reaches its base branch.
---

Harmonic runs the verification you configure for a Task, whether you create
it by hand or mirror it from a tracker. Commands and Critics are empty by
default. Configure them in [Settings & overrides](/harmonic/run/settings/)
to check work before it completes.

## Verification

An Attempt starts with implementation. The agent makes the changes and
commits them. Harmonic then runs each configured verification command in
order, stopping at the first failure. Once commands pass, it runs the
configured Critics in parallel. Every check must pass.

A failed command, a Critic rejection, or an inconclusive result feeds the
next Attempt in the same working directory. Once the maximum number of
Attempts is reached, the Task is escalated for a human to resolve.

Configure Task pre-merge and post-merge checks separately. Epic verification
has its own configuration. See [Epics](/harmonic/work/epics/) for how a group
of Tasks is verified and integrated.

To reuse a result elsewhere, such as in a tracker comment or a steer, hover
over it on the ticket page and click the copy icon. It's on a Critic's summary,
a verify command's result and its output, and each of the agent's messages.
Code blocks in Markdown have one too. Summaries and messages copy as Markdown,
and verify output copies in full, even when the page shows only part of it.

## Completion and merging

Successful Tasks complete automatically after their configured checks.
This applies to both manually created and mirrored Tasks. There is no
separate Accept or Reject gate for a manually created Task.

With **Direct** isolation, the agent works in the Workspace's Working
Directory and completes in place. With **Worktree** isolation, the Task
has its own branch and working directory. Its **merge fate** determines
what happens after verification:

| Merge fate | What happens |
| --- | --- |
| **Merge** | Merge the branch into its base branch. |
| **Open a PR** | Push the branch and open a pull request for your usual PR flow. |
| **Leave the branch** | Leave the branch for you or CI to pick up. |

Merge is the shipped default. Merge fate applies to worktree-isolated
Tasks, where there is a separate branch to integrate. See
[Branches & worktrees](/harmonic/work/branches-and-worktrees/) for how
Harmonic reconciles base-branch movement and handles conflicts.

If work needs a human decision or exhausts its Attempts, open the escalated
Task to resolve it. An escalation keeps the work and its history available
so you can decide how to proceed.

## When a merge is handed back

If a merge can't finish, Harmonic escalates the Task and the merge progress
says why:

- **Merge conflict.** The work clashed with the base branch and the agent
  couldn't resolve it in its allowed turns.
- **Post-merge check failed.** A post-merge command went red after the merge.
  Harmonic reverts the merge and records the revert on the Timeline.
- **Base update failed.** Harmonic couldn't write the base branch, for example
  because another git process held its lock. Nothing in the work conflicted.
