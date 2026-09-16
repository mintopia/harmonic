---
title: The fleet dashboard
description: Global scope — one view across every Workspace, and the dashboard that leads it.
---

A Harmonic instance runs many Workspaces, and most pages show you one at a
time. When you want to answer "across everything I run, what needs me, what's
it costing, what's in flight", switch to **Global** scope.

## Workspace and Global scope

Every view runs in one of two scopes. **Workspace** is the default — each page
reads only the Workspace you've picked. **Global** aggregates across all of
them. You choose the scope in the Workspace switcher, where **Global** sits as
a peer entry above the Workspace rows; pick it and the whole app switches to
the fleet-wide view.

Tasks, Activity, Timeline, Stats, and Operations all have a Global form that
folds every Workspace into one list, each row tagged with the Workspace it
came from.

## The dashboard

Global scope opens on the **Dashboard** — the one screen built to be read
first. It leads with what needs you, then what's in flight, then what it's
costing, and ranks your Workspaces in a table by cost today: alongside cost it
shows how many tickets need you, how many are in flight, token throughput,
cache-hit rate, and the 7-day cost. Pick any Workspace — its row, or its badge
in the token chart above the table — to drop into it.

An instance with a single Workspace skips the Dashboard. The homepage opens
straight on that Workspace's Board, since there's nothing yet to compare it
against — add a second Workspace and the Dashboard becomes the homepage
again.

## Telling Workspaces apart

Each Workspace carries a colour and its first initial as a badge, shown in the
switcher and on every Global-scope list, so a row's origin reads at a glance
without hunting for the name.

## URLs carry the scope

Scope lives in the URL path. Global views sit at the top
level (`/`, `/tasks`, `/stats`, …) and Workspace views under
`/workspace/<id>/…`, so any view is bookmarkable and the back button steps
through exactly where you've been.
