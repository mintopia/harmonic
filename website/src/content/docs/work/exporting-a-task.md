---
title: Exporting a task
description: Get a finished task's full record out of Harmonic as a single download, see where each Export was delivered, and run it again.
---

Once a task is **done** or **cancelled**, its ticket page gets an **Export**
panel, between the task progress bar and the Attempt details. An Export is a
single `.tar.gz` file holding the task's full record: the ticket, its
timeline and the Attempt transcripts. Secrets such as tokens are redacted
before anything leaves Harmonic.

The panel only appears for finished tasks. A task that is still queued,
running or waiting on you has nothing to export yet.

## What the panel shows

- **The latest Export**: the file name (with a button to copy it), when it
  was built, its size, and how many secrets were redacted.
- **Destinations**: one row per place the Export is sent (a folder on disk,
  or an S3 bucket). Each row says **Delivered**, with the time, or
  **Failed**, with the last error.
- **Earlier Exports**: a collapsed list of previous Exports for the task,
  newest first. Every Export is kept separately; a new one never overwrites
  an old one.

## When a delivery fails

A failed Destination shows its error and what happens next, for example
*Retry 2 of 3 in 27 min*. Harmonic retries a failed delivery on its own up to
three times, then stops and shows **Retries exhausted**. From then on, **Export
again** is the way forward. Once a Destination does succeed, its row flips to
**Delivered**.

The ticket's Timeline records each step as its own event, tagged
**EXPORT**: the Export being built, each delivery, and each failure and
retry.

## Export again

**Export again** builds a fresh Export and sends it to every enabled
Destination, whatever the automatic export rules say. The button is disabled
while it runs, then the panel refreshes and tells you whether each delivery
succeeded or failed.

If it can't run, the reason appears in the panel. The usual one is that no
Destination is turned on; enable one in settings and try again.

## Download

**Download** saves an Export to your computer through the browser. It builds
a fresh copy each time and doesn't need a Destination to be set up. A
download is just a copy for you; it doesn't appear in the Destinations list
or the Earlier Exports.

## Partial exports

A task that finished before Harmonic kept its own Archive is marked
**partial**, with a note on the panel. Harmonic builds the Export from
whatever records survive, and some transcripts may be missing. Nothing is
wrong; the older task simply has less to give.

The same idea shows up in a transcript: when an agent's own log has been
cleaned up, Harmonic reads its own copy instead and marks the transcript
**from Archive**.
