# Tasks: Agent Messages

Vertical slices in dependency order. Epic #757; blockers are native GitHub
dependencies.

## 1. (#758) Prefactor: MCP caller identity and conditional tool registration
Blocked by: none.
- [ ] `/mcp` resolves the bearer Attempt Key to Attempt, Task, Workspace, scope
- [ ] Server builder receives the caller and can register tools conditionally
- [ ] Existing tools behave unchanged; MCP test proves the caller is visible

## 2. (#759) Settings: `agentMessagesEnabled` and `agentMessagesSendCap`
Blocked by: none.
- [ ] Registry, config schema, baseline, Workspace column, store, Settings UI
- [ ] Workspace API reports the effective enabled flag; Global reports "on anywhere"
- [ ] Settings-registry and Workspace-override tests cover resolution

## 3. (#760) Send, read, list: tools, storage, addressing, cap
Blocked by: 1, 2.
- [ ] Agent Messages table, migration baseline, migration test
- [ ] `send_message`, `read_messages`, `list_peers` registered only when enabled
- [ ] Task and Epic addressing, refusals, per-Attempt cap, Thread grouping
- [ ] MCP test: two Attempt Keys exchange messages end to end

## 4. (#761) Delivery: steer channel, held messages, receipts, peer line
Blocked by: 3.
- [ ] Live recipient receives over the steer channel with the peer frame
- [ ] Held messages injected at next Attempt start from the database
- [ ] Receipts queued / delivered / held / refused recorded per recipient
- [ ] Prompt peer line when enabled; stub-Harness test incl. restart

## 5. (#762) Task timeline rows
Blocked by: 3.
- [ ] `agent-message` timeline kind in DTO and web types
- [ ] Sent and received rows on both Tasks with receipt, preview, View Thread
- [ ] Lifecycle-timeline model test; screenshot vs v1 timeline mock

## 6. (#764) Activity tab: Threads list and transcript
Blocked by: 3, 4.
- [ ] Threads API (Workspace and Global, Epic/Task/live filters)
- [ ] Activity tabs; Thread list, transcript, receipts, identity colours
- [ ] Conversations-page style model tests; screenshot vs v5 mock (desktop dark/light)

## 7. (#765) Activity tab: Agents drawer, Global scope, hiding, mobile
Blocked by: 2, 6.
- [x] Agents drawer (Harness/model, state, Attempt, sends meter, Open Task)
- [x] Global aggregation, Workspace filter and row badges
- [x] Tab hidden where off (Global: off everywhere); 390px overlay layout
- [ ] Model tests; screenshot vs v5 mock (mobile drawer and list)

## 8. (#763) Archive/Export and deletion
Blocked by: 3.
- [ ] `agent-messages.json` in Task export plus README row; Epic export list
- [ ] Workspace deletion cascades; Thread survives a participant's deletion
- [ ] Task-export test
