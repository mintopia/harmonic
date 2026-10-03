// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { activity, agentMessageThreads, handlers } = vi.hoisted(() => ({
  activity: vi.fn(),
  agentMessageThreads: vi.fn(),
  handlers: [] as ((message: { type: string }) => void)[],
}));
vi.mock('../web/src/api.js', () => ({ api: { activity, agentMessageThreads } }));
vi.mock('../web/src/ws.js', () => ({
  subscribe: (handler: (message: { type: string }) => void) => {
    handlers.push(handler);
    return () => {};
  },
}));

import { ActivityView } from '../web/src/components/ActivityView.js';
import type { AgentMessage, AgentMessageThread } from '../web/src/types.js';
import { cleanup, flush, makeConfig, mountComponent } from './component-smoke-harness.js';

const base = Date.now() - 60_000;

function msg(id: string, sender: number, to: number, text: string, createdAt: number, over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageId: id,
    role: 'agent',
    parts: [{ kind: 'text', text }],
    replyTo: null,
    threadId: 't1',
    senderTaskId: sender,
    senderDeleted: false,
    senderAttemptId: 1,
    workspaceId: 1,
    createdAt,
    recipients: [{ taskId: to, receipt: 'delivered', mode: 'mid-turn', deleted: false }],
    ...over,
  };
}

function threadWith(messages: AgentMessage[]): AgentMessageThread {
  return {
    threadId: 't1',
    workspaceId: 1,
    workspaceName: 'Harmonic',
    latestAt: messages.at(-1)?.createdAt ?? 0,
    live: true,
    messages,
    participants: [
      { taskId: 412, title: 'Session refactor', harness: 'claude', epicId: 400, deleted: false, ...EXTRA },
      { taskId: 413, title: 'Merge policy', harness: 'codex', epicId: 400, deleted: false, ...EXTRA },
    ],
  };
}

const EXTRA = { model: null, state: 'working' as const, betweenAttempts: false, attemptNumber: 1, sends: 0, sendCap: 10, lastMessageAt: null };

const first = msg('m1', 412, 413, 'I renamed `retire()` to `retireSession()`.', base);

async function mount() {
  return mountComponent(createElement(ActivityView, { config: makeConfig() }));
}

describe('Activity Agent Messages tab', () => {
  afterEach(async () => {
    await cleanup();
    activity.mockReset();
    agentMessageThreads.mockReset();
    handlers.length = 0;
  });

  it('hides the tab bar when Agent Messages are disabled', async () => {
    activity.mockResolvedValue({ processes: [], agentMessagesEnabledInAnyWorkspace: false });
    const host = await mount();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(agentMessageThreads).not.toHaveBeenCalled();
  });

  it('renders both tabs with a message count and a read-only transcript', async () => {
    activity.mockResolvedValue({ processes: [], agentMessagesEnabledInAnyWorkspace: true });
    agentMessageThreads.mockResolvedValue({ threads: [threadWith([first])], total: 1, totalMessages: 1 });
    const host = await mount();

    const tabs = [...host.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Running now0', 'Agent Messages1']);
    expect(host.textContent).toContain('Nothing running');

    await act(async () => {
      (tabs[1] as HTMLElement).click();
      await flush();
    });
    expect(host.textContent).toContain('1 thread · 1 message');
    expect(host.querySelector('[aria-label="Thread transcript"]')?.textContent).toContain('retireSession()');
    expect(host.querySelector('code')?.textContent).toBe('retire()');
    expect(host.querySelector('[aria-label="delivered mid-turn"]')?.textContent).toBe('✓✓');
    expect(host.querySelector('textarea')).toBeNull();
    expect([...host.querySelectorAll('input')].map((i) => i.type)).toEqual(['search']);
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.textContent).not.toMatch(/\b(Send|Steer)\b(?!\s+a Task)/);
  });

  it('shows a new message in the open thread when a change event arrives', async () => {
    activity.mockResolvedValue({ processes: [], agentMessagesEnabledInAnyWorkspace: true });
    agentMessageThreads.mockResolvedValue({ threads: [threadWith([first])], total: 1, totalMessages: 1 });
    const host = await mount();
    await act(async () => {
      (host.querySelectorAll('[role="tab"]')[1] as HTMLElement).click();
      await flush();
    });
    expect(host.textContent).not.toContain('Thanks, switching now');

    agentMessageThreads.mockResolvedValue({
      threads: [threadWith([first, msg('m2', 413, 412, 'Thanks, switching now', base + 1000, { replyTo: 'm1' })])],
      total: 1,
      totalMessages: 2,
    });
    await act(async () => {
      for (const handler of handlers) handler({ type: 'agent_messages_changed' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await flush();
    });
    expect(host.querySelector('[aria-label="Thread transcript"]')?.textContent).toContain('Thanks, switching now');
    expect(host.textContent).toContain('1 thread · 2 messages');
  });

  it('coalesces a burst of change events into one reload', async () => {
    activity.mockResolvedValue({ processes: [], agentMessagesEnabledInAnyWorkspace: true });
    agentMessageThreads.mockResolvedValue({ threads: [threadWith([first])], total: 1, totalMessages: 1 });
    await mount();
    const before = agentMessageThreads.mock.calls.length;
    await act(async () => {
      for (let i = 0; i < 5; i++) for (const handler of handlers) handler({ type: 'agent_messages_changed' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await flush();
    });
    expect(agentMessageThreads.mock.calls.length - before).toBe(1);
  });

  it('asks the server to filter and keeps the Epic options while a filter is active', async () => {
    activity.mockResolvedValue({ processes: [], agentMessagesEnabledInAnyWorkspace: true });
    agentMessageThreads.mockImplementation(async (params: { epicId?: number }) =>
      params.epicId === undefined
        ? { threads: [threadWith([first])], total: 1, totalMessages: 1 }
        : { threads: [], total: 0, totalMessages: 0 },
    );
    const host = await mount();
    await act(async () => {
      (host.querySelectorAll('[role="tab"]')[1] as HTMLElement).click();
      await flush();
    });
    const select = host.querySelectorAll('select')[1] as HTMLSelectElement;
    await act(async () => {
      select.value = '1:400';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
    expect(agentMessageThreads).toHaveBeenCalledWith(expect.objectContaining({ epicId: 400, limit: 200 }));
    expect(host.textContent).toContain('0 threads · 0 messages');
    expect([...host.querySelectorAll('select')[1]!.options].map((o) => o.textContent)).toEqual(['All Epics', 'Epic #400']);
    expect(host.querySelectorAll('[role="tab"]')[1]?.textContent).toBe('Agent Messages1');
  });

  it('shows the Workspace filter, row badges and the Agents drawer at Global scope', async () => {
    activity.mockResolvedValue({ processes: [], agentMessagesEnabledInAnyWorkspace: true });
    agentMessageThreads.mockResolvedValue({ threads: [threadWith([first])], total: 1, totalMessages: 1 });
    const host = await mount();
    await act(async () => {
      (host.querySelectorAll('[role="tab"]')[1] as HTMLElement).click();
      await flush();
    });
    expect([...host.querySelectorAll('select')[0]!.options].map((o) => o.textContent)).toEqual(['All Workspaces', 'Harmonic']);
    expect(host.querySelector('[role="button"][aria-current="true"]')?.textContent).toContain('Harmonic');
    const drawer = host.querySelector('[aria-label="Thread agents"]') as HTMLElement;
    expect(drawer.textContent).toContain('Open Task →');
    expect(drawer.querySelector('a')?.getAttribute('href')).toMatch(/^\/workspace\/\d+\/task\/\d+$/);
    expect(drawer.textContent).toMatch(/\d+\/\d+/);
    expect(drawer.textContent).not.toMatch(/steer/i);
  });
});
