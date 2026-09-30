---
title: Notifications
description: Get a ping when a ticket needs you or the queue is done, in Discord, Slack, email, or your own webhook.
---

Harmonic runs on its own, so notifications are how it taps you on the
shoulder: a ticket needs a decision, the work's finished, or the queue has
drained. Every important server-side outcome is recorded in your in-app
inbox; you can also set up external channels (Discord, Slack, email, webhook)
to receive them wherever you prefer.

## In-app Notifications

Every server-side outcome worth attention—a Task failed, escalated, or merged;
an Export failed—is stored in Harmonic with a read/unread state, whether or not
a browser was open when it happened. Your own failed clicks show only as a
transient toast, never as a Notification.

**The bell** sits in the top navigation and shows an unread count (red badge,
hidden at 0, capped at 99+). Click it to open a dropdown showing your latest
10 Notifications. Opening the dropdown does not mark them read; click a row to
mark it read and open the related Ticket. The **Mark all read** button keeps
the menu open.

**The Notifications page** (`/notifications`) shows every retained Notification
grouped by day. Click any row to mark it read and navigate to the Ticket. Use
the severity filter (All, Failures, Escalations, Merges, Exports) and the
**Unread only** switch to narrow the list. In Global scope, rows tagged with
each Workspace's Colour so you can tell them apart.

Both the bell dropdown and the page follow your current scope—in Workspace scope
you see only that Workspace's Notifications; in Global scope you see all of them.

**Retention**: Notifications are kept for 30 days, up to 1000 in total
(older ones are pruned automatically). Read state is one global state, shared
across browsers and devices.

## Where pings go

A **notification channel** is a place Harmonic sends pings. You can add as
many as you like, of four kinds:

- **Discord** — paste a channel's webhook URL.
- **Slack** — paste an incoming-webhook URL.
- **Email** — give it your mail server details and an address.
- **Your own webhook** — Harmonic posts to a URL you choose, for wiring
  into something custom.

Channels are set up once on the global settings page and shared across all
your workspaces.

## What you can be pinged about

Pick any mix of these per channel:

| Ping | When |
| --- | --- |
| **Needs you** | A ticket escalated and is waiting on a human. |
| **Done** | A ticket finished. |
| **Queue idle** | Everything ready has run; nothing's left. |
| **Started** | A ticket started running. |
| **Created** | A new ticket appeared. |

A new channel starts subscribed to **just "needs you"** on purpose, the
one moment you actually have to act, so you're not drowned in noise. Turn
on more only if you want them.

## Sending a ticket somewhere specific

Beyond the global channels, you can point an individual ticket at a
channel, handy when one piece of work wants eyes in a particular place
even if that channel isn't subscribed to everything.

## Good to know

Pings are best-effort: if a channel is unreachable when an event fires,
Harmonic logs it and moves on rather than retrying, so a flaky endpoint
never holds up your work.
