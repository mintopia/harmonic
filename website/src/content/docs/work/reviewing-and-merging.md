---
title: Reviewing & merging
description: How a workflow checks work with commands and Critics, and how successful work reaches its base branch.
---

A Task's workflow decides how its work is checked. Verification commands and
Critics are steps of the workflow, so the checks are whatever its steps say.
Edit them in [Workflows](/work/workflows/).

## Verification

An Attempt runs the workflow. In `implement`, a Pass has the agent make the
changes and commit them, then runs the `verify` step, then the Critic if
enabled. A failed command, a Critic rejection, or an inconclusive result starts
the next Pass in the same working directory. Once the workflow's maximum
number of Passes is reached, the Task is escalated for a human to resolve.

The Ticket page shows each step that ran as a row in the selected Attempt, with
its status, summary and duration. Expand a row for its output (a command), its
transcript (an agent) or its verdict and findings (a Critic). A Pass selector
appears when more than one Pass ran.

Each Critic runs on the Harness and Model set on its `critic` step. To turn the
Critic on in `implement` and pick them, see
[Workflows](/work/workflows/#configure-the-critic).

Pre-merge and post-merge checks are separate steps of the workflow. Epics are
verified by the `epic` workflow. See [Epics](/work/epics/) for how a group of
Tasks is verified and integrated.

To reuse a result elsewhere, such as in a tracker comment or a steer, hover
over it on the ticket page and click the copy icon. It's on a Critic's summary,
a verify command's result and its output, and each of the agent's messages.
Code blocks in Markdown have one too. Summaries and messages copy as Markdown,
and verify output copies in full, even when the page shows only part of it.

The prompt sent to each agent (the **Resolved Prompt**) is shown inline on the
ticket page in a **Sent prompt** block, at the point where it was sent. You see
the text exactly as the agent received it, with placeholders and included prompts
already filled in.

## Completion and merging

Successful Tasks complete automatically after the workflow's checks.
This applies to both manually created and mirrored Tasks. There is no
separate Accept or Retry gate for a manually created Task.

With **Direct** isolation, the agent works in the Workspace's Working
Directory and completes in place. With **Worktree** isolation, the Task
has its own branch and working directory. The workflow's publish step
determines what happens after verification:

| Step | What happens |
| --- | --- |
| `merge` | Merge the branch into its base branch. |
| `open-pr` | Push the branch and open a pull request for your usual PR flow. |
| `artifact` | Leave the branch or output for you or CI to pick up. |

`implement` ships with `merge`. These steps apply to worktree-isolated
Tasks, where there is a separate branch to integrate. See
[Branches & worktrees](/work/branches-and-worktrees/) for how
Harmonic reconciles base-branch movement and handles conflicts.

When an Attempt opens a pull or merge request, a **PR / MR** link appears on
the Task page above the Attempt details, taking you to the request on the forge.
If multiple Attempts open requests, the link points to the newest one.

After a successful merge, Harmonic closes the mirrored ticket in the tracker.
If the close fails, the Task still completes and shows a **ticket close
pending** badge. Harmonic retries the close on each tracker poll until it
succeeds.

If work needs a human decision or exhausts its Attempts, open the escalated
Task to resolve it. An escalation keeps the work and its history available
so you can decide how to proceed. Accept, Retry and Close are described in
[Steering the fleet](/work/steering-the-fleet/#retry-accept-and-close).

## When a merge is handed back

If a merge can't finish, Harmonic escalates the Task and the merge progress
says why:

- **Merge conflict.** The work clashed with the base branch and the agent
  couldn't resolve it in its allowed turns (**Merge-conflict turns**, which
  applies to Tickets and Epics).
- **Post-merge check failed.** A post-merge command went red after the merge.
  Harmonic reverts the merge and records the revert on the Timeline.
- **Base update failed.** Harmonic couldn't write the base branch, for example
  because another git process held its lock. Nothing in the work conflicted.
