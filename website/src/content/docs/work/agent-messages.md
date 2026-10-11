---
title: Agent Messages
description: How agents working in the same Workspace message each other, where you read those messages, how to turn them on and cap them, and what an Export holds.
---

When several agents work in the same Workspace, for example the Members of
an Epic running in parallel, they sometimes need to tell each other
something: "I changed this interface", "are you touching that file?". An
**Agent Message** is a note one agent sends to another Task, or to every open
Member of its own Epic.

You read these messages but can't write them, since Agent Messages have no
composer and no steer control. To change what an agent does, steer its Task
as usual (see [Steering the fleet](/work/steering-the-fleet/)).

Messages are one-way. The sender doesn't wait for an answer. A reply is
just another Agent Message, and a message plus its replies make a **Thread**.

## Turn it on

Agent Messages are off until you turn them on. Open
[Settings](/run/settings/#agent-messages), go to the **Execution**
tab and find the **Agent Messages** section.

1. Turn on **Let Attempts message each other**.
2. Set **Send cap**, the most Agent Messages one Attempt may send. The
   default is 10.

Set them globally, or override either one for a single Workspace. While it's
off, agents aren't offered the ability to send messages.

The cap keeps two agents from answering each other without end. It counts
per Attempt, so a new Attempt starts again from zero.

## Read them in Activity

Once Agent Messages are on, **Activity** gets two tabs: **Running now** and
**Agent Messages**. The second tab shows a count of all messages. Open Activity
from a Workspace to see that Workspace's Threads, or from the global view to
see every Workspace's.

The tab has three parts.

- **Threads**: the list on the left, newest first. Each row shows the
  Thread's title, who took part, and how long ago the latest message was. A
  green pulsing dot means an agent in the Thread is still live. In the global
  view each row also carries its Workspace name. **Filter threads** searches
  the list. If there are more Threads than fit, a note says how many are shown, for example *Showing
  20 of 35 threads*.
- **Transcript**: the Thread you picked, in order. Messages are grouped by
  sender, with the sender's Harness icon, name and time. A reply quotes the
  message it answers. Each message says who it was **to**.
- **Agents**: a panel on the right, opened with the **Agents** button and
  closed with **Hide**, with a card for each Task in the Thread.

At the top, filters narrow the Threads by **Workspace** (global view only),
**Epic** and **Task**. **Only live** keeps Threads with an agent still
running.

### Delivery marks

Each message shows how it reached each recipient:

| Mark | Meaning |
| --- | --- |
| ✓ | Queued. It reaches the agent at its next turn. |
| ✓✓ | Delivered to the running agent. |
| ◷ | Held. The recipient has no agent running, so it gets the message when its next Attempt starts. |
| ✕ | Refused, for example because the recipient Task is done or cancelled. |

A message sent to an Epic shows one mark for each Member that received it.

### The Agents panel

Each card shows the Task number and title, its Harness and model, its state,
and its Attempt number. A Task between Attempts says so.

The **sends** meter, for example *7/10 sends*, is how many messages that
Attempt has sent against its cap. It turns red when the Attempt reaches the
cap, after which it can't send more. **Last message** gives the time of the
agent's latest send, or *none sent*. **Open Task →** goes to the ticket.

A Thread outlives its Tasks. If a Task was deleted, its card reads *deleted
Task*.

## On a Task's Timeline

Each message also appears on the Timeline of both Tasks involved, as **Agent
Message sent** or **Agent Message received**. The row shows the other Task, the
delivery state (*delivered mid-turn*, *queued, next turn*, *held, next
Attempt* or *refused*), a short preview, and **View Thread →**, which opens
the Thread in Activity. On the sender's side it also shows which send this
was, for example *send 3 of 10 this Attempt*.

## Exports include them

A Task's [Export](/work/archive-and-export/) contains
`agent-messages.json`, listing the Agent Messages that Task sent or received,
with their recipients and delivery states. An Epic's Export has the same file
for its Members. Redaction applies to it like every other file.

## See also

- [Settings & overrides](/run/settings/#agent-messages)
- [Epics](/work/epics/)
- [Steering the fleet](/work/steering-the-fleet/)
