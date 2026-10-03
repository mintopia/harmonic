import type { AgentMessage, AgentMessageRecipient, AgentMessageThread, AgentMessageThreadParticipant } from '../types.js';

const today = (h: number, m: number, s = 0) => {
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.getTime();
};

const person = (taskId: number, title: string, harness: string, deleted = false, extra: Partial<AgentMessageThreadParticipant> = {}): AgentMessageThreadParticipant => ({
  taskId,
  title: deleted ? null : title,
  harness: deleted ? null : harness,
  epicId: deleted ? null : '400',
  deleted,
  model: deleted ? null : 'claude-sonnet-4-5',
  state: deleted ? null : 'working',
  betweenAttempts: false,
  attemptNumber: deleted ? null : 1,
  sends: 0,
  sendCap: 10,
  lastMessageAt: null,
  ...extra,
});

const to = (taskId: number, receipt: AgentMessageRecipient['receipt'], extra: Partial<AgentMessageRecipient> = {}): AgentMessageRecipient => ({
  taskId,
  receipt,
  deleted: false,
  ...extra,
});

let seq = 0;
const say = (threadId: string, sender: number, createdAt: number, text: string, recipients: AgentMessageRecipient[], replyTo: string | null = null, id = `m${++seq}`): AgentMessage => ({
  messageId: id,
  role: 'agent',
  parts: [{ kind: 'text', text }],
  replyTo,
  threadId,
  senderTaskId: sender,
  senderDeleted: false,
  senderAttemptId: 1,
  workspaceId: 1,
  createdAt,
  recipients,
});

const ago = (minutes: number) => Date.now() - minutes * 60_000;

const main = [
  say('t1', 412, today(14, 2), "I've renamed `SessionStore.retire()` to `retireSession()` and moved it to `src/domain/sessions.ts` — update imports if you touch it. The old name is gone, not aliased.", [to(413, 'delivered', { mode: 'mid-turn' }), to(414, 'queued'), to(416, 'held')], null, 'root'),
  say('t1', 412, today(14, 2, 40), 'Tests moved with it: `tests/domain/sessions.test.ts`.', [to(413, 'delivered', { mode: 'mid-turn' }), to(414, 'delivered', { mode: 'mid-turn' }), to(416, 'held')]),
  say('t1', 413, today(14, 3), 'Thanks. I do call it from `mergeMember()`; switching to `retireSession()` now. Is the signature unchanged?', [to(412, 'delivered', { mode: 'mid-turn' })], 'root', 'q1'),
  say('t1', 413, today(14, 3, 40), "Also: I'll hold my merge hook until your branch merges.", [to(412, 'delivered', { mode: 'mid-turn' })]),
  say('t1', 412, today(14, 5), 'Unchanged: `retireSession(id: SessionId, reason: RetireReason)`. Only the name and file moved.', [to(413, 'queued', { deliveredAt: today(14, 5, 19) })], 'q1'),
  say('t1', 414, today(14, 7), 'Got it. My retry loop imported the old name in `src/execution/backoff.ts`; fixed in my branch, nothing for you to do.', [to(412, 'delivered', { mode: 'mid-turn' })], 'root'),
  say('t1', 412, today(14, 11), 'Does `session.idleTtl` still need a migration for existing config files?', [to(411, 'refused', { reason: 'Task done' })]),
];

const quick = (id: string, a: number, b: number, text: string, ageMinutes: number, live: boolean, ps: AgentMessageThreadParticipant[]): AgentMessageThread => ({
  threadId: id,
  workspaceId: 1,
  workspaceName: 'Harmonic',
  latestAt: ago(ageMinutes),
  live,
  messages: [say(id, a, ago(ageMinutes), text, [to(b, 'delivered', { mode: 'mid-turn' })])],
  participants: ps,
});

export const agentMessageThreads: AgentMessageThread[] = [
  {
    threadId: 't1',
    workspaceId: 1,
    workspaceName: 'Harmonic',
    latestAt: ago(2),
    live: true,
    messages: main,
    participants: [
      person(412, 'Session refactor', 'claude', false, { model: 'sonnet-5.5', attemptNumber: 2, sends: 7, lastMessageAt: today(14, 11) }),
      person(413, 'Merge policy', 'codex', false, { model: 'gpt-5-codex', sends: 2, lastMessageAt: today(14, 4) }),
      person(414, 'Retry backoff', 'copilot', false, { model: 'gpt-5', sends: 1, lastMessageAt: today(14, 7) }),
      person(416, 'Docs sweep', 'claude', false, { model: 'sonnet-5.5', betweenAttempts: true }),
      person(411, 'Config schema', 'codex', false, { model: 'gpt-5-codex', state: 'done', attemptNumber: 3, sends: 10, lastMessageAt: today(13, 40) }),
    ],
  },
  quick('t2', 413, 414, 'Are you editing src/execution/merge.ts?', 9, true, [person(413, 'Merge policy', 'codex'), person(414, 'Retry backoff', 'copilot')]),
  quick('t3', 415, 416, 'Test fixtures moved to tests/fixtures/sessions/', 24, true, [person(415, 'Fixtures', 'claude'), person(416, 'Docs sweep', 'claude')]),
  quick('t4', 411, 412, 'Config key renamed: session.idleTtl', 60, false, [person(411, 'Config schema', 'codex'), person(412, 'Session refactor', 'claude')]),
  quick('t5', 410, 411, 'Heads up: lint rule no-restricted-imports now fails CI', 180, false, [person(410, 'Lint', 'copilot'), person(411, 'Config schema', 'codex')]),
  quick('t6', 999, 413, 'Can you review the Attempt log shape?', 1440, false, [person(999, '', '', true), person(413, 'Merge policy', 'codex')]),
  {
    threadId: 't7',
    workspaceId: 2,
    workspaceName: 'Atlas',
    latestAt: ago(15),
    live: true,
    messages: [say('t7', 21, ago(15), 'Schema migration is ready for review.', [to(22, 'delivered', { mode: 'mid-turn' })])],
    participants: [person(21, 'Schema migration', 'claude', false, { epicId: '9' }), person(22, 'API client', 'codex', false, { epicId: '9', state: 'escalated' })],
  },
];
