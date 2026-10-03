import { describe, expect, it } from 'vitest';
import {
  NO_THREAD_FILTER,
  agentCards,
  epicKey,
  resolveActivityTab,
  showWorkspaceBadge,
  workspaceOptions,
  bodyParts,
  countLine,
  epicOptions,
  filterThreads,
  identityFor,
  receiptsFor,
  resolveSelectedThread,
  segmentThread,
  taskOptions,
  threadParticipantsLine,
  threadTitle,
  type TranscriptGroup,
} from '../web/src/agent-messages-model.js';
import type { AgentMessage, AgentMessageThread, AgentMessageThreadParticipant } from '../web/src/types.js';

const NOW = new Date(2026, 9, 3, 15, 0, 0).getTime();
const at = (h: number, m: number, s = 0, day = 3) => new Date(2026, 9, day, h, m, s).getTime();

function participant(taskId: number, over: Partial<AgentMessageThreadParticipant> = {}): AgentMessageThreadParticipant {
  return { taskId, title: `Task ${taskId}`, harness: 'claude', epicId: 400, deleted: false, model: null, state: 'working', betweenAttempts: false, attemptNumber: 1, sends: 0, sendCap: 10, lastMessageAt: null, ...over };
}

function message(id: string, sender: number, createdAt: number, over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageId: id,
    role: 'agent',
    parts: [{ kind: 'text', text: `text ${id}` }],
    replyTo: null,
    threadId: 't',
    senderTaskId: sender,
    senderDeleted: false,
    senderAttemptId: 1,
    workspaceId: 1,
    createdAt,
    recipients: [{ taskId: sender === 1 ? 2 : 1, receipt: 'delivered', mode: 'mid-turn', deleted: false }],
    ...over,
  };
}

function thread(id: string, over: Partial<AgentMessageThread> = {}): AgentMessageThread {
  const messages = over.messages ?? [message(`${id}-1`, 1, at(14, 0))];
  return {
    threadId: id,
    workspaceId: 1,
    workspaceName: 'Harmonic',
    latestAt: messages.at(-1)?.createdAt ?? 0,
    live: false,
    messages,
    participants: [participant(1), participant(2)],
    ...over,
  };
}

describe('filterThreads', () => {
  const a = thread('a', { latestAt: 100, live: true });
  const b = thread('b', { latestAt: 300, participants: [participant(3, { epicId: 500 }), participant(4, { epicId: 500 })] });
  const c = thread('c', { latestAt: 200, messages: [message('c1', 1, 1, { parts: [{ kind: 'text', text: 'Rename the Retire helper' }] })] });
  const all = [a, b, c];

  it('orders by latest activity, newest first, ties by thread id', () => {
    const tie = thread('z', { latestAt: 300 });
    expect(filterThreads([a, b, c, tie], NO_THREAD_FILTER).map((t) => t.threadId)).toEqual(['z', 'b', 'c', 'a']);
  });

  it('keeps only live threads with Only live', () => {
    expect(filterThreads(all, { ...NO_THREAD_FILTER, liveOnly: true }).map((t) => t.threadId)).toEqual(['a']);
  });

  it('filters by Epic and by Task participation', () => {
    expect(filterThreads(all, { ...NO_THREAD_FILTER, epicId: 500 }).map((t) => t.threadId)).toEqual(['b']);
    expect(filterThreads(all, { ...NO_THREAD_FILTER, taskId: 4 }).map((t) => t.threadId)).toEqual(['b']);
    expect(filterThreads(all, { ...NO_THREAD_FILTER, taskId: 1 }).map((t) => t.threadId)).toEqual(['c', 'a']);
  });

  it('matches the text filter against messages and participants, every word', () => {
    expect(filterThreads(all, { ...NO_THREAD_FILTER, query: 'retire HELPER' }).map((t) => t.threadId)).toEqual(['c']);
    expect(filterThreads(all, { ...NO_THREAD_FILTER, query: '#3' }).map((t) => t.threadId)).toEqual(['b']);
    expect(filterThreads(all, { ...NO_THREAD_FILTER, query: 'nothing here' })).toEqual([]);
  });

  it('combines filters', () => {
    expect(filterThreads(all, { workspaceId: null, epicId: 400, taskId: 2, liveOnly: true, query: 'text' }).map((t) => t.threadId)).toEqual(['a']);
  });

  it('derives Epic and Task options', () => {
    expect(epicOptions(all).map((o) => o.epicId)).toEqual([400, 500]);
    expect(taskOptions(all, 500).map((t) => t.taskId)).toEqual([3, 4]);
    expect(taskOptions([thread('d', { participants: [participant(1), participant(9, { deleted: true, title: null })] })], null).map((t) => t.taskId)).toEqual([1]);
  });

  it('resolves the selection to the first listed thread when it is gone', () => {
    expect(resolveSelectedThread([a, b], 'b')?.threadId).toBe('b');
    expect(resolveSelectedThread([a, b], 'gone')?.threadId).toBe('a');
    expect(resolveSelectedThread([], 'a')).toBeNull();
  });
});

describe('thread summary', () => {
  it('titles a thread with a one-line snippet of its latest message', () => {
    const long = 'x'.repeat(200);
    const t = thread('a', { messages: [message('m1', 1, 1), message('m2', 2, 2, { parts: [{ kind: 'text', text: `first line\n${long}` }] })] });
    const title = threadTitle(t);
    expect(title.startsWith('first line xxx')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('lists participants and the Epic only when a message reached several Tasks', () => {
    const solo = thread('a', { participants: [participant(1), participant(2, { harness: 'codex' }), participant(3, { deleted: true, title: null, harness: null })] });
    expect(threadParticipantsLine(solo)).toBe('#1 Claude · #2 Codex · deleted Task');
    const multi = thread('b', {
      messages: [message('m', 1, 1, { recipients: [{ taskId: 2, receipt: 'queued', deleted: false }, { taskId: 3, receipt: 'queued', deleted: false }] })],
      participants: [participant(1), participant(2), participant(3)],
    });
    expect(threadParticipantsLine(multi)).toContain('→ Epic #400');
  });

  it('counts threads and messages with plurals', () => {
    expect(countLine(2, 3)).toBe('2 threads · 3 messages');
    expect(countLine(1, 1)).toBe('1 thread · 1 message');
    expect(countLine(0, 0)).toBe('0 threads · 0 messages');
  });
});

describe('segmentThread', () => {
  const groups = (items: ReturnType<typeof segmentThread>) => items.filter((i): i is TranscriptGroup => i.kind === 'group');

  it('folds consecutive messages from one sender into one group', () => {
    const t = thread('a', { messages: [message('m1', 1, at(14, 0)), message('m2', 1, at(14, 1)), message('m3', 2, at(14, 2)), message('m4', 1, at(14, 3))] });
    const g = groups(segmentThread(t, NOW));
    expect(g.map((x) => [x.senderTaskId, x.messages.length])).toEqual([[1, 2], [2, 1], [1, 1]]);
    expect(g[0]?.time).toMatch(/14.00/);
  });

  it('emits a day separator first and when the day changes, and a time separator after a quiet gap', () => {
    const t = thread('a', {
      messages: [message('m1', 1, at(23, 58, 0, 2)), message('m2', 1, at(0, 1, 0, 3)), message('m3', 1, at(0, 20, 0, 3))],
    });
    const items = segmentThread(t, NOW);
    expect(items.map((i) => i.kind)).toEqual(['day', 'group', 'day', 'group', 'time', 'group']);
    expect(items.filter((i) => i.kind === 'day').map((i) => ('label' in i ? i.label : ''))).toEqual(['Yesterday', 'Today']);
  });

  it('breaks a group at a separator even when the sender repeats', () => {
    const t = thread('a', { messages: [message('m1', 1, at(14, 0)), message('m2', 1, at(14, 30))] });
    expect(groups(segmentThread(t, NOW)).map((g) => g.messages.length)).toEqual([1, 1]);
  });

  it('quotes the replied-to message with its sender, time and a snippet', () => {
    const parent = message('p', 2, at(14, 0), { parts: [{ kind: 'text', text: 'Is the signature unchanged? '.repeat(10) }] });
    const reply = message('r', 1, at(14, 1), { replyTo: 'p' });
    const g = groups(segmentThread(thread('a', { messages: [parent, reply] }), NOW));
    const quote = g[1]?.messages[0]?.quote;
    expect(quote?.sender).toBe('#2');
    expect(quote?.time).toMatch(/14.00/);
    expect(quote?.text.endsWith('…')).toBe(true);
    expect(g[0]?.messages[0]?.quote).toBeNull();
  });

  it('gives a multi-recipient message one receipt per recipient and an Epic address', () => {
    const m = message('m', 1, at(14, 0), {
      recipients: [
        { taskId: 2, receipt: 'delivered', mode: 'mid-turn', deleted: false },
        { taskId: 3, receipt: 'queued', deleted: false },
        { taskId: 4, receipt: 'held', deleted: false },
      ],
    });
    const t = thread('a', { messages: [m], participants: [participant(1), participant(2), participant(3), participant(4)] });
    const msg = groups(segmentThread(t, NOW))[0]?.messages[0];
    expect(msg?.to).toBe('Epic #400');
    expect(msg?.receipts.map((r) => [r.taskId, r.tick, r.tail])).toEqual([[2, '✓✓', ''], [3, '✓', ''], [4, '◷', '']]);
  });

  it('assigns identity colours in participant order, repeating after three', () => {
    const ps = [1, 2, 3, 4, 5].map((id) => participant(id));
    expect([1, 2, 3, 4, 5].map((id) => identityFor(ps, id))).toEqual([1, 2, 3, 1, 2]);
    expect(identityFor(ps, 99)).toBeNull();
  });

  it('shows a deleted sender and recipient as deleted', () => {
    const m = message('m', 9, at(14, 0), { senderDeleted: true, recipients: [{ taskId: 8, receipt: 'delivered', deleted: true }] });
    const t = thread('a', { messages: [m], participants: [participant(9, { deleted: true, title: null, harness: null }), participant(8, { deleted: true, title: null })] });
    const g = groups(segmentThread(t, NOW))[0];
    expect(g?.name).toBe('#9 deleted Task');
    expect(g?.messages[0]?.receipts[0]?.label).toBe('deleted Task');
  });
});

describe('receiptsFor', () => {
  const recipient = (over: Partial<AgentMessage['recipients'][number]>): AgentMessage =>
    message('m', 1, 1, { recipients: [{ taskId: 2, receipt: 'queued', deleted: false, ...over }] });

  it('maps each state to its tick', () => {
    const tick = (receipt: 'queued' | 'delivered' | 'held' | 'refused') => receiptsFor(recipient({ receipt }))[0]?.tick;
    expect([tick('queued'), tick('delivered'), tick('held'), tick('refused')]).toEqual(['✓', '✓✓', '◷', '✕']);
  });

  it('keeps detail in the tail for a single recipient', () => {
    expect(receiptsFor(recipient({ receipt: 'delivered', mode: 'mid-turn' }))[0]?.tail).toBe('mid-turn');
    expect(receiptsFor(recipient({ receipt: 'queued', deliveredAt: at(14, 5, 19) }))[0]?.tail).toMatch(/^delivered 14.05.19$/);
    const refused = receiptsFor(recipient({ receipt: 'refused', reason: 'Task done' }))[0];
    expect(refused?.tail).toBe('refused: Task done');
    expect(refused?.describe).toBe('refused: Task done');
  });

  it('keeps only a reason in the tail across several recipients', () => {
    const m = message('m', 1, 1, {
      recipients: [
        { taskId: 2, receipt: 'delivered', mode: 'mid-turn', deleted: false },
        { taskId: 3, receipt: 'refused', reason: 'Task done', deleted: false },
      ],
    });
    expect(receiptsFor(m).map((r) => r.tail)).toEqual(['', 'refused: Task done']);
  });
});

describe('bodyParts', () => {
  it('splits backtick spans into inline code', () => {
    expect(bodyParts('call `retireSession()` now')).toEqual([
      { code: false, value: 'call ' },
      { code: true, value: 'retireSession()' },
      { code: false, value: ' now' },
    ]);
    expect(bodyParts('no code ` here')).toEqual([{ code: false, value: 'no code ` here' }]);
  });
});

describe('Global scope', () => {
  const harmonic = thread('h', { latestAt: 300, participants: [participant(1, { epicId: 400 }), participant(2, { epicId: 400 })] });
  const other = thread('o', { workspaceId: 2, workspaceName: 'Atlas', latestAt: 200, participants: [participant(1, { epicId: 400 }), participant(7, { epicId: 9 })] });
  const both = [harmonic, other];

  it('aggregates Threads from both Workspaces newest first', () => {
    expect(filterThreads(both, NO_THREAD_FILTER).map((t) => [t.threadId, t.workspaceName])).toEqual([
      ['h', 'Harmonic'],
      ['o', 'Atlas'],
    ]);
  });

  it('lists Workspaces by name and badges rows only at Global with All Workspaces', () => {
    expect(workspaceOptions(both)).toEqual([
      { id: 2, name: 'Atlas' },
      { id: 1, name: 'Harmonic' },
    ]);
    expect(showWorkspaceBadge(true, { workspaceId: null })).toBe(true);
    expect(showWorkspaceBadge(true, { workspaceId: 2 })).toBe(false);
    expect(showWorkspaceBadge(false, { workspaceId: null })).toBe(false);
  });

  it('a Workspace filter hides the other Workspace Threads', () => {
    expect(filterThreads(both, { ...NO_THREAD_FILTER, workspaceId: 2 }).map((t) => t.threadId)).toEqual(['o']);
    expect(filterThreads(both, { ...NO_THREAD_FILTER, workspaceId: 1 }).map((t) => t.threadId)).toEqual(['h']);
  });

  it('keys Epic options by Workspace, prefixing the name only when asked', () => {
    expect(epicOptions(both, null, true).map((o) => [o.key, o.label])).toEqual([
      [epicKey(2, 9), 'Atlas · Epic #9'],
      [epicKey(2, 400), 'Atlas · Epic #400'],
      [epicKey(1, 400), 'Harmonic · Epic #400'],
    ]);
    expect(epicOptions(both, 2).map((o) => o.label)).toEqual(['Epic #9', 'Epic #400']);
    expect(taskOptions(both, null, 2).map((t) => t.taskId)).toEqual([1, 7]);
    expect(taskOptions(both, null, 1).map((t) => t.taskId)).toEqual([1, 2]);
  });
});

describe('resolveActivityTab', () => {
  it('only offers the messages tab where Agent Messages are on', () => {
    expect(resolveActivityTab('messages', true)).toBe('messages');
    expect(resolveActivityTab('messages', false)).toBe('running');
    expect(resolveActivityTab('running', false)).toBe('running');
  });
});

describe('agentCards', () => {
  it('marks the cap rose only at sends >= cap and carries the meter ratio', () => {
    const t = thread('x', { participants: [participant(1, { sends: 7, sendCap: 10 }), participant(2, { sends: 10, sendCap: 10 }), participant(3, { sends: 12, sendCap: 10 })] });
    const [under, at_cap, over] = agentCards(t, NOW);
    expect([under!.sendsCount, under!.sendsRatio, under!.atCap]).toEqual(['7/10', 0.7, false]);
    expect([at_cap!.sendsRatio, at_cap!.atCap]).toEqual([1, true]);
    expect([over!.sendsRatio, over!.atCap]).toEqual([1, true]);
  });

  it('describes state, between Attempts, Attempt number and last message', () => {
    const t = thread('x', {
      participants: [
        participant(1, { model: 'sonnet-5.5', betweenAttempts: true, attemptNumber: 3, lastMessageAt: NOW - 5 * 60_000 }),
        participant(2, { state: 'done' }),
      ],
    });
    const [a, b] = agentCards(t, NOW);
    expect(a).toMatchObject({ state: 'working', betweenAttempts: true, attemptLabel: 'Attempt 3', model: 'sonnet-5.5', lastMessage: '5m ago', identity: 1, harnessLabel: 'Claude' });
    expect(b).toMatchObject({ state: 'done', betweenAttempts: false, lastMessage: 'none sent', identity: 2 });
  });

  it('keeps a deleted participant as a muted card', () => {
    const t = thread('x', { participants: [participant(9, { deleted: true, title: null, harness: null, state: null, attemptNumber: null })] });
    expect(agentCards(t, NOW)[0]).toMatchObject({ deleted: true, title: 'deleted Task', state: null, attemptLabel: null });
  });
});
