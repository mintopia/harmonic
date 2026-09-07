---
title: Notifications
description: Get a ping when a ticket needs you or the queue is done, in Discord, Slack, email, or your own webhook.
---

Harmonic runs on its own, so notifications are how it taps you on the
shoulder: a ticket needs a decision, the work's finished, or the queue has
drained. You set up where those pings go and which ones you want, then
stop watching the board.

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
