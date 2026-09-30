## ADDED Requirements

### Requirement: Export on terminal disposition

When `export.enabled` is true, the system SHALL build an Export on every terminal disposition included in `export.includeStates`:
- *done*
- *cancelled*
- Delete of a Task that has at least one Attempt

Every disposition SHALL produce a new Export; no Export is ever overwritten. Building and delivering an Export SHALL NOT block or revert the disposition. The ticket snapshot and timeline SHALL be captured at trigger time.

#### Scenario: Task merged
- **WHEN** a Task reaches *done*
- **THEN** an Export named `<workspace>/<taskId>-<trackerRef?>-done-<ISO timestamp>.tar.gz` is produced

#### Scenario: Task deleted after escalation
- **GIVEN** an escalated Task with two Attempts
- **WHEN** it is Deleted
- **THEN** an Export with disposition `deleted` is produced, containing its ticket and timeline as they were at Delete time

#### Scenario: Deleted Task with no Attempts
- **WHEN** a Task that never ran is Deleted
- **THEN** no Export is produced

#### Scenario: Second disposition
- **GIVEN** a Task already exported on *cancelled*
- **WHEN** the Task later reaches another terminal disposition
- **THEN** a second Export is produced
- **AND** the first is untouched

#### Scenario: Export disabled
- **WHEN** `export.enabled` is false
- **THEN** no Export is built, and the Archive is still written

### Requirement: Export contents

Each Export SHALL be a gzipped tar containing:
- the Task's Archive files
- `ticket.json` (ticket snapshot)
- `timeline.json`
- `operator-inputs.json`
- `manifest.json` (versions, file counts, disposition, redaction match counts per pattern, `partial` flag)
- a human-readable `README.md`

An Epic's Export SHALL contain the Epic's own Attempts, including their verification and Critic outputs, plus the Epic's timeline. Its `manifest.json` SHALL list each Member's Export filename and status, without copying Member contents.

#### Scenario: Task Export layout
- **WHEN** an Export is extracted
- **THEN** it contains `manifest.json`, `README.md`, `ticket.json`, `timeline.json`, `operator-inputs.json`, and `attempts/<n>/…` for every Attempt

#### Scenario: Epic Export
- **WHEN** an Epic reaches *done*
- **THEN** its Export contains its Epic Attempts' verification and Critic outputs and its timeline
- **AND** `manifest.json` lists every Member's Export filename and status

### Requirement: Redaction at Export time

The system SHALL redact Export contents while building the Export, and SHALL leave the local Archive raw.
- The pattern set SHALL be the union of a baseline set (`aws-access-key`, `aws-secret-key`, `github-token`, `gitlab-token`, `bearer`, `sk-api-key`), global `export.redact.patterns`, and Workspace patterns. Workspace patterns are additive and cannot remove global or baseline patterns.
- Each match SHALL be replaced with `[REDACTED:<pattern-id>]`.
- Matches that span stream chunk boundaries SHALL be redacted.

#### Scenario: Token in verify output
- **GIVEN** a verify command printed a GitHub token
- **WHEN** the Export is built
- **THEN** the Export's `output.log` shows `[REDACTED:github-token]` in its place
- **AND** the local Archive `output.log` still holds the raw text

#### Scenario: Workspace adds a pattern
- **GIVEN** a Workspace pattern `{ id: "internal-host", regex: "corp\\.example\\.internal" }`
- **WHEN** a Task in that Workspace is exported
- **THEN** both the baseline patterns and `internal-host` are applied

### Requirement: Export Destinations

The system SHALL deliver each Export to every enabled Export Destination independently.
- **Directory Destination:** `export.directory.path`.
- **S3-compatible Destination:** `export.s3.{endpoint, region, bucket, prefix, forcePathStyle}`. Credentials SHALL come from `accessKeyId`/`secretAccessKey` when both are set, and otherwise from the AWS default credential chain.
- All settings SHALL be global with a per-Workspace override.
- S3 credentials SHALL be masked in every config API response and in the UI.

#### Scenario: Both Destinations configured
- **WHEN** an Export is built with a directory and an S3 bucket configured
- **THEN** it is written to both, and each Destination's status is recorded separately

#### Scenario: Workspace override
- **GIVEN** a global bucket `harmonic-exports` and a Workspace override bucket `team-a-exports`
- **WHEN** a Task in that Workspace is exported
- **THEN** it is written to `team-a-exports` only

#### Scenario: Credentials masked
- **WHEN** the config API returns S3 settings
- **THEN** `secretAccessKey` and `accessKeyId` are masked

### Requirement: Export failure handling

Each Export attempt per Destination SHALL be recorded as a timeline Fact. When a Destination fails, the system SHALL:
- show the failure on the Ticket page
- show a toast to all connected UI clients
- emit `export.failed` to Notification Channels
- retry that Destination alone via a Scheduled Job at 5 min, 30 min, and 2 h, then stop

A successful Export SHALL produce only a timeline Fact.

#### Scenario: S3 unreachable
- **GIVEN** a directory and an S3 Destination, with S3 unreachable
- **WHEN** a Task reaches *done*
- **THEN** the Task stays *done*
- **AND** the directory Export succeeds
- **AND** the S3 failure shows on the Ticket page, as a toast, and as an `export.failed` notification
- **AND** only S3 is retried

#### Scenario: Retries exhausted
- **WHEN** the third retry fails
- **THEN** no further automatic retry is scheduled
- **AND** the failure remains on the Ticket page

### Requirement: Manual Export actions

The Ticket page SHALL offer:
- **Export again**, which rebuilds the Export and delivers it to all enabled Destinations
- **Download**, which streams a freshly built, redacted Export to the browser

For a Task that finished before this feature shipped, the rebuilt Export SHALL be built from whatever DB rows and native transcripts still exist, and SHALL be flagged `partial: true`. Settings SHALL offer **Test Destination**, which writes and then deletes a probe object and reports success or the error.

#### Scenario: Re-export after fixing credentials
- **GIVEN** an S3 Destination with exhausted retries
- **WHEN** the operator fixes the credentials and clicks **Export again**
- **THEN** a new Export is delivered and the Ticket page shows success

#### Scenario: Pre-feature Task
- **WHEN** the operator clicks **Export again** on a Task finished before this feature
- **THEN** the Export's `manifest.json` has `partial: true`

#### Scenario: Test Destination
- **WHEN** the operator clicks **Test Destination** with a wrong bucket name
- **THEN** the Settings page shows the S3 error
- **AND** no probe object remains
