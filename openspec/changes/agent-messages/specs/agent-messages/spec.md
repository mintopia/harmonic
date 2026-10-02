# Capability: Agent Messages

## ADDED Requirements

### Requirement: Agent Message tools are offered only where enabled

The MCP server SHALL register `send_message`, `read_messages`, and
`list_peers` on an MCP session only when the caller's Attempt Key belongs to
a Task Attempt in a Workspace whose effective `agentMessagesEnabled` setting
is on. Where off, the tools SHALL be absent from the tool list and the
Attempt's prompt SHALL carry no peer line.

#### Scenario: Workspace enabled
- **WHEN** an Attempt Key for a Task Attempt in an enabled Workspace lists tools
- **THEN** the three tools are present

#### Scenario: Workspace disabled
- **WHEN** an Attempt Key for a Task Attempt in a disabled Workspace lists tools
- **THEN** none of the three tools is present and calling one returns an unknown-tool error

#### Scenario: Non-Task caller
- **WHEN** a key for a Conversation, Epic resolve agent, or Critic lists tools
- **THEN** none of the three tools is present, whatever the setting

### Requirement: Addressing

`send_message` SHALL accept a recipient that is a Task in the sender's
Workspace or the literal address of the sender's own Epic. Addressing the Epic
SHALL produce one Agent Message with one recipient entry per open sibling
Member. The tool SHALL refuse a recipient Task that is *draft*, *done*, or
*cancelled*, a Task outside the sender's Workspace, or the sender itself.

#### Scenario: Send to a sibling Task
- **WHEN** Attempt A of Task #412 sends to Task #413 in the same Workspace
- **THEN** one Agent Message is stored with sender #412, one recipient #413, and the result reports the message id

#### Scenario: Send to own Epic
- **WHEN** Task #412, a Member of Epic #400 with open siblings #413 and #414 and a done sibling #415, sends to its Epic
- **THEN** one Agent Message is stored with recipients #413 and #414 only

#### Scenario: Refused recipient
- **WHEN** a Task sends to a Task that is done, cancelled, draft, in another Workspace, or is itself
- **THEN** the tool returns a refusal naming the reason and nothing is stored

### Requirement: Payload shape

An Agent Message SHALL carry a message id, a role, an ordered list of text
Parts, an optional reply reference to another Agent Message, the sender Task
and Attempt, the Workspace, and a created-at time. `read_messages` SHALL
return messages in this shape.

#### Scenario: Reply forms a Thread
- **WHEN** Task #413 sends a message whose reply reference names a message from #412
- **THEN** both messages belong to one Thread rooted at the #412 message

### Requirement: Per-Attempt send cap

Each Attempt SHALL be allowed at most `agentMessagesSendCap` sends (a Setting
Override, default 10). A send beyond the cap SHALL be refused and nothing
stored. The cap SHALL count per Attempt, so a fresh Attempt of the same Task
starts at zero.

#### Scenario: Cap reached
- **WHEN** an Attempt with a cap of 10 makes its eleventh send
- **THEN** the tool returns a refusal that names the cap and nothing is stored

### Requirement: Peers

`list_peers` SHALL return the sender's open sibling Members (Task id, title,
lifecycle state, whether an Agent is live) and the Epic address. It SHALL not
include Tasks outside the sender's Epic.

#### Scenario: List peers
- **WHEN** Task #412 in Epic #400 calls `list_peers`
- **THEN** it receives #413 and #414, their states, and the Epic address

### Requirement: Delivery to a live recipient

When the recipient Task has a live Agent, the Agent Message SHALL be delivered
over the steer channel, framed as a message from the peer Task and never as an
operator instruction. The receipt SHALL be *delivered* with the delivery mode
(mid-turn or next turn) and time.

#### Scenario: Harness supports mid-turn steering
- **WHEN** the recipient's Harness supports mid-turn steering and the message is sent
- **THEN** the recipient's Agent receives it mid-turn and the receipt reads delivered mid-turn

#### Scenario: Harness delivers at a turn boundary
- **WHEN** the recipient's Harness lacks mid-turn steering
- **THEN** the receipt reads queued until the next turn starts, then delivered

### Requirement: Held messages

When the recipient has no live Agent (*ready*, *paused*, *escalated*, between
Attempts), the Agent Message SHALL be stored with receipt *held* and injected,
with every other held message for that Task in send order, at the start of the
Task's next Attempt under a peer-messages heading distinct from operator
messages. After injection the receipt SHALL read *delivered*.

#### Scenario: Recipient between Attempts
- **WHEN** Task #414 is between Attempts and receives two messages
- **THEN** both are held, and the prompt of #414's next Attempt contains both under the peer-messages heading, after which both receipts read delivered

#### Scenario: Harmonic restarts while messages are held
- **WHEN** Harmonic restarts before #414's next Attempt
- **THEN** the held messages are still injected at that Attempt's start

### Requirement: Receipt states

Each recipient entry SHALL have exactly one receipt state: *queued*,
*delivered*, *held*, or *refused*, with a reason on *refused* and a time on
*delivered*.

#### Scenario: Epic send with mixed recipients
- **WHEN** an Epic-addressed message reaches one live and one between-Attempts sibling
- **THEN** the first recipient entry reads delivered and the second reads held

### Requirement: Operator visibility in Activity

The web UI SHALL show an "Agent Messages" tab inside Activity, beside "Running
now". The tab SHALL list Threads, show the selected Thread as a transcript
(left-aligned, grouped by consecutive sender, quoted reply snippet, day and
time separators, one time per group header, receipts per recipient), and show
an Agents drawer listing each participant's Harness and model, lifecycle
state, Attempt number, sends used against the cap, and an "Open Task" link.
The tab SHALL offer no composer and no steer control.

#### Scenario: Open a Thread
- **WHEN** the operator opens the tab in a Workspace with Threads and selects one
- **THEN** its messages render in order with sender tiles, receipts, and the Agents drawer

#### Scenario: Read-only
- **WHEN** the operator views any Thread
- **THEN** no input, textarea, or steer action is present

### Requirement: Global scope aggregates Workspaces

At Global scope the tab SHALL aggregate Threads from every Workspace, offer a
Workspace filter ahead of the Epic filter, and badge each Thread row with its
Workspace while the filter is "All".

#### Scenario: Two Workspaces with Threads
- **WHEN** the operator opens the tab at Global scope
- **THEN** Threads from both Workspaces list with Workspace badges, and choosing one Workspace hides the other's

### Requirement: Tab hidden where the feature is off

The tab SHALL be hidden in a Workspace whose effective setting is off, and at
Global scope hidden only when the setting is off in every Workspace. Threads
from a Workspace that is now off SHALL not appear in the tab but SHALL remain
in Archive/Export.

#### Scenario: Workspace off
- **WHEN** the operator opens Activity in a Workspace with the feature off
- **THEN** only "Running now" is shown, with no tab bar entry for Agent Messages

#### Scenario: Global, one Workspace on
- **WHEN** one of two Workspaces has the feature on
- **THEN** the Global Activity page shows the tab with that Workspace's Threads only

### Requirement: Task timeline rows

Each Agent Message SHALL appear as a Lifecycle row on the sender's Task
("Agent Message sent to #<n> · <Harness>") and on each recipient's Task
("Agent Message received from #<n> · <Harness>"), with the receipt state, a
one-line preview, and a "View Thread" link to the Activity tab.

#### Scenario: Both sides
- **WHEN** #412 sends to #413
- **THEN** #412's timeline shows a sent row and #413's timeline shows a received row, both linking to the same Thread

### Requirement: Persistence, Archive and deletion

Agent Messages SHALL be persisted, included in a Task's Archive/Export beside
operator inputs, and deleted with their Workspace. A Thread SHALL survive the
deletion of one participant Task, showing that side as deleted.

#### Scenario: Export
- **WHEN** a Task that sent and received Agent Messages is exported
- **THEN** the bundle contains an agent-messages file listing them and the README documents it

#### Scenario: Participant deleted
- **WHEN** Task #413 is deleted after a Thread with #412
- **THEN** the Thread still lists in the tab with #413 shown as deleted

### Requirement: Settings

`agentMessagesEnabled` (boolean, default off) and `agentMessagesSendCap`
(integer, default 10) SHALL be Setting Overrides resolvable Baseline → Global
→ Workspace, editable on the Settings pages, and reported per Workspace by
the API so the web UI can gate the tab.

#### Scenario: Workspace override
- **WHEN** Global is off and a Workspace is set on
- **THEN** that Workspace's Attempts get the tools and its Activity shows the tab
