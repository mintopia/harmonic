---
title: Archive & export
description: What Harmonic keeps of every task, how to get a finished task out as a single file, where each Export was delivered, and how to run it again.
---

Harmonic keeps a full record of every task on its own disk, called the
**Archive**. When a task finishes, Harmonic can bundle that record into an
**Export**, a single `.tar.gz` file with secrets redacted, and send it to a
folder or an S3 bucket. You can also download one from the ticket page.

Export is off until you turn it on. See [Turn Export on](#turn-export-on).

## The Archive

Harmonic starts an Archive for every task when the task is created. You
don't need to configure anything. It holds:

- the prompt sent to each agent, and everything the agent did, for the
  implementation and for every Critic;
- a copy of each agent harness's own log, taken when its step ends;
- the complete output of every verify command, with nothing cut;
- everything you did to the task: steers, Accept, Reject with its reason,
  Pause and Resume, Close and Cancel.

The Archive lives in Harmonic's data directory (`~/.harmonic` unless you set
`HARMONIC_DATA_DIR`), under `archive/<workspace>/`. It is stored raw, with no
redaction, so it holds any token or password an agent saw. Restrict access to
it the way you would the agents' own logs on that host.

Deleting a task leaves its Archive in place. By default Harmonic keeps every
Archive forever. To cap that, see [Retention](#retention).

### When an agent's log is gone

Agent harnesses clean up their own logs (Claude, for example, deletes them
after about 30 days). When a task's log has been removed, Harmonic shows its
Archive copy instead, and the transcript is marked **from Archive** with the
note *Harness log no longer on disk*. Critic logs fall back and are marked
the same way.

Verify output in the UI is a preview, capped at 200,000 characters. When it
is cut, a **View full output** button below it opens the complete output from
the Archive.

## The Export panel

Once a task is **done** or **cancelled**, its ticket page shows an **Export**
panel between the progress bar and the Attempt details. A task that is still
queued, running or waiting on you has nothing to export yet.

The panel shows:

- **The latest Export**: its file name (with a copy button), when it was
  built, its size, and how many secrets were redacted.
- **Destinations**: one row for each place the Export went, a folder or an
  S3 bucket. Each row says **Delivered** with the time, or **Failed** with
  the error.
- **Earlier Exports**: a collapsed list of previous Exports for the task,
  newest first. Each Export is a separate file. A new one never overwrites
  an old one.

### Export again

**Export again** builds a new Export and sends it to every enabled
Destination, even if the task's disposition isn't one your settings export
automatically. The button reads **Exporting…** while it runs. Afterwards the
panel tells you which Destinations got it and which failed.

If no Destination is turned on, the button can't run and the panel says so.
Turn one on in settings and try again.

### Download

**Download** saves an Export to your computer through the browser. It builds
a new file each time and works with no Destination set up. A download is only
a copy for you, so it doesn't show up under Destinations or Earlier Exports.

### When a delivery fails

A failed Destination shows its error and the next retry, for example
*Retry 2 of 3 at 15:30*. Harmonic retries on its own after 5 minutes, 30
minutes and 2 hours. After the third failure the row reads **Retries
exhausted**. Fix the problem, then use **Export again**.

A failure also raises a toast and sends an `export.failed` event to your
[notification channels](/harmonic/work/notifications/).

The ticket's Timeline records each step as its own event tagged **EXPORT**:
the Export being built, each delivery, and each failure. If building the
Export fails, Harmonic rebuilds it on the same schedule.

### Partial exports

Tasks that finished before Harmonic had the Archive have no Archive to
export. Export again or Download on one of those builds the Export from
whatever records are left, and marks it **partial**. Some transcripts may be
missing.

## What's in an Export

Each Destination files Exports in a folder per Workspace. The file is named
`<task>-<issue>-<disposition>-<timestamp>.tar.gz`, for example
`412-88-done-20261001T142233.511Z.tar.gz` for task 412, issue #88. A task
with no tracker issue skips that part. If a file with the same name already
exists, the new one gets a number on the end.

Unpacked, it contains:

| File | What it holds |
| --- | --- |
| `README.md` | A summary: title, issue link, Workspace, disposition, dates, Attempt count, and a guide to the other files |
| `ticket.json` | The task as Harmonic showed it at export time |
| `timeline.json` | The task's Timeline: Attempts, verification, merge and other events |
| `operator-inputs.json` | Everything you did to the task |
| `agent-messages.json` | Messages the task's agent sent to or received from other tasks |
| `manifest.json` | Export details: Harmonic version, disposition, file counts, redaction counts, whether it is partial, and git details |
| `archive.json` | The Archive's identity and its Export history |
| `attempts/` | One folder per Attempt: prompts, agent transcripts, harness logs, verify output and Critic runs |

The git details in `manifest.json` give the repository URL (with any
credentials removed), the base branch, the commit the task started from, the
commit it ended on, and the merge commit if it merged. Each Attempt gets its
own start and end commit too. The Export doesn't include the diff itself;
run `git diff <startCommit> <endCommit>` in your own clone to get it.

### Redaction

Before an Export leaves Harmonic, it replaces anything that looks like a
secret with `[REDACTED:<pattern-id>]`. Six patterns are always on: AWS
access keys, AWS secret keys, GitHub tokens, GitLab tokens, bearer tokens
and `sk-` API keys. You can add your own in settings.

Redaction only applies to Exports. The Archive on disk stays raw.

### Epics

When an Epic merges, Harmonic writes an Epic Export too, named
`epic-<ref>-done-<timestamp>.tar.gz`. It holds the Epic's own verification
and Critic runs and its Timeline, and lists its Members rather than copying
their Exports.

Epic Exports go to the same Destinations as task Exports, with the same
retries and failure notifications. Once an Epic has merged, its page shows the
same Export panel as a ticket, with **Export again** and **Download**. Each
build, delivery and failure appears on the Epic's Timeline, tagged **EXPORT**.

## Turn Export on

Everything lives on the **Archive & Export** tab in
[Settings](/harmonic/run/settings/#archive--export).

1. Turn on **Export on terminal disposition**.
2. Leave **Dispositions to export** at *done*, *cancelled* and *deleted*, or
   untick the ones you don't want. A deleted task is only exported if an
   agent worked on it.
3. Set up at least one Destination: a **Directory** path on the Harmonic
   host, an **S3-compatible** bucket, or both.
4. Click **Test Destination** on each one. It writes a probe file and
   removes it.

From then on, every task that reaches one of those dispositions is exported
automatically. Exporting never holds up or reverses the task itself.

## Retention

Archives grow with every task. To cap them, set **Keep for (days)**,
**Max total size (MB)**, or both, on the same settings tab. A Scheduled Job
called **Archive retention** runs every hour and deletes the oldest Archives
first. You'll find it under Operations.

It never deletes the Archive of:

- a task that is still in progress;
- a task that finished less than an hour ago;
- a task whose Export has failed or is waiting on a retry.

Epic Archives follow the same rules, counting from when the Epic merged.

A Workspace can set its own limits. Its Archives are then counted and pruned
on their own, separately from the rest.
