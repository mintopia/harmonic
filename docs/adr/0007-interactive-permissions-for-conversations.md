# Interactive, human-in-the-loop permissions for Conversations

In a Conversation the `ConversationDriver` holds the harness's ACP
`session/request_permission` request *open* and prompts the operator over
the UI, resolving the request only when they pick an option. The agent's
turn genuinely blocks on the human. This is the deliberate inverse of the
`Runner`, which auto-picks `allow_always`/`allow_once` so autonomous Runs
never wait. Remembering has three tiers: **Allow once**, **Allow for this
conversation** (native ACP `allow_always`, dies with the Conversation), and
an opt-in persistent **Permission Rule** keyed on tool **kind** + Working
Directory, surfaced and revocable in Settings.

We chose interactive-by-default because a Conversation's entire purpose is
to keep the human in the loop; auto-approving would make it a slower Run.
We chose tool-kind + directory as the persistent-rule key (over exact tool
name, per-command, or a global per-kind allowlist) as the point that is
coarse enough to accumulate usefully yet scoped enough not to silently
green-light a shell tool in an unrelated repo.

## Consequences

- Persistent Permission Rules are auto-approval, a security escalation on
  par with the `agentReview` flag. They are therefore opt-in (never the
  default click), operator-visible, and revocable; remembering you cannot
  audit or undo is not offered.
- The permission round-trip spans transports: the request is broadcast over
  the firehose WS and answered via `POST /conversations/:id/permissions/:reqId`,
  so the driver keeps a pending-request registry keyed by id.
