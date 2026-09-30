## ADDED Requirements

### Requirement: Per-Task Archive identity

Every Task SHALL be assigned a UUID `archiveId` at creation, and its Archive SHALL live at `<dataDir>/archive/<workspace>/<taskId>-<archiveId>/` as files, never as DB rows. Each Archive SHALL contain an `archive.json` recording the Task id, `archiveId`, tracker ref, title, Workspace, creation time, terminal dispositions, and per-Destination Export status.

#### Scenario: Archive created with a new Task
- **WHEN** a Task is created
- **THEN** it receives a unique `archiveId`
- **AND** its Archive directory and `archive.json` exist on disk once its first Step starts

#### Scenario: Task id reused after DB recreate
- **GIVEN** an Archive exists for Task 12 from before a DB recreate
- **WHEN** a new Task with id 12 is created
- **THEN** the new Task's Archive is a different directory
- **AND** the old Archive is untouched

### Requirement: Transcript capture

The system SHALL tee every ACP `session/update` of every implementation and Critic Session to `acp.jsonl` in the Archive for the Step it belongs to. At the end of each Step, the system SHALL copy the Harness's native transcript and its Subagent files, if present, into that Step's `native/` directory. The system SHALL also write every resolved prompt sent to a Session to the Step's `prompt.md`.

#### Scenario: Implementation Step captured
- **WHEN** an Implementation Step completes
- **THEN** its Archive directory contains `prompt.md`, `acp.jsonl`, and a `native/` copy of the native transcript

#### Scenario: Critic Step captured
- **WHEN** a Critic Step completes
- **THEN** its Archive directory contains the Critic's `prompt.md`, `acp.jsonl`, and `native/` copy

#### Scenario: Harness with no native transcript
- **WHEN** a Step completes on a Harness that writes no native JSONL
- **THEN** `acp.jsonl` and `prompt.md` are present
- **AND** `native/` is absent, with no failure raised

#### Scenario: Crash mid-Step
- **WHEN** Harmonic restarts after a crash during a Step
- **THEN** crash recovery copies the native transcript for that Step into the Archive

### Requirement: Full verify-command output

The system SHALL write the full, uncapped combined stdout and stderr of every verify command, pre-merge and post-merge, to `output.log` in the Archive. The DB preview SHALL keep both the head and the tail within its existing cap and SHALL mark the elision explicitly.

#### Scenario: Output exceeds the preview cap
- **WHEN** a verify command prints 1 MB of output
- **THEN** `output.log` contains all 1 MB
- **AND** the DB preview contains the head and the tail, separated by a truncation marker stating how many characters were elided

### Requirement: Operator input record

The system SHALL record every operator input to `operator-inputs.jsonl` in the Archive, with timestamp, actor, action, and text. Operator inputs are steer, Reject reason, Accept, Pause, Resume, Close, and Cancel. Accept and Close/Cancel (with actor and reason) SHALL also be recorded as timeline Facts.

#### Scenario: Operator accepts an escalation
- **WHEN** an operator Accepts an escalated Task
- **THEN** an Accept Fact appears on the timeline
- **AND** an entry is appended to `operator-inputs.jsonl`

#### Scenario: Operator cancels with a reason
- **WHEN** an operator cancels a Task with the reason "superseded"
- **THEN** the timeline and `operator-inputs.jsonl` record the actor and the reason "superseded"

### Requirement: Archive outlives its Task

Task Delete SHALL NOT remove the Task's Archive. Only the retention cap SHALL remove Archives.

#### Scenario: Task deleted
- **WHEN** a Task is Deleted
- **THEN** its Archive directory remains on disk
- **AND** its `archive.json` records the deletion

### Requirement: Log views fall back to the Archive

Transcript log views SHALL read the native transcript first. If the native transcript is missing or unreadable, they SHALL fall back to the Archive copy. They SHALL show "log unavailable" only when neither exists.

#### Scenario: Harness pruned its log
- **GIVEN** the Harness has deleted the native transcript for a finished Attempt
- **WHEN** the operator opens that Attempt's log
- **THEN** the log renders from the Archive copy

### Requirement: Retention cap

The system SHALL support optional `archive.retain.days` and `archive.retain.maxTotalMB` limits, both off by default, enforced by a Scheduled Job that yields between Archives.
- The job SHALL prune oldest terminal-disposition first.
- It SHALL NOT prune the Archive of a non-terminal Task.
- It SHALL NOT prune an Archive whose Export is pending or failed.

#### Scenario: Age cap
- **GIVEN** `archive.retain.days` is 30
- **WHEN** the prune job runs
- **THEN** Archives whose Task reached a terminal disposition more than 30 days ago, and whose Exports all succeeded or are disabled, are removed

#### Scenario: Pending Export protects an Archive
- **GIVEN** an Archive past the age cap with an Export Destination still failed
- **WHEN** the prune job runs
- **THEN** that Archive is kept

#### Scenario: Caps off by default
- **WHEN** no retention setting is configured
- **THEN** no Archive is ever pruned
