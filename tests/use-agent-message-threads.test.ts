// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { agentMessageThreads } = vi.hoisted(() => ({ agentMessageThreads: vi.fn() }));
vi.mock('../web/src/api.js', () => ({ api: { agentMessageThreads } }));
vi.mock('../web/src/ws.js', () => ({ subscribe: () => () => {} }));

import { useAgentMessageThreads } from '../web/src/useAgentMessageThreads.js';
import { THREAD_PAGE_SIZE } from '../web/src/agent-messages-model.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  await cleanup();
  agentMessageThreads.mockReset();
});

describe('useAgentMessageThreads paging', () => {
  it('fetches only the first page after the filter changes', async () => {
    agentMessageThreads.mockResolvedValue({ threads: [], total: THREAD_PAGE_SIZE * 5, totalMessages: 0 });
    let latest!: ReturnType<typeof useAgentMessageThreads>;
    function Probe() {
      const value = useAgentMessageThreads(null, true);
      useEffect(() => {
        latest = value;
      });
      return null;
    }
    await mountComponent(createElement(Probe));
    await act(async () => {
      latest.loadMore();
      await flush();
    });
    expect(agentMessageThreads.mock.calls.some(([p]) => p.offset === THREAD_PAGE_SIZE)).toBe(true);

    agentMessageThreads.mockClear();
    await act(async () => {
      latest.setFilter({ workspaceId: null, epicId: null, taskId: null, liveOnly: true });
      await flush();
    });
    const offsets = agentMessageThreads.mock.calls.map(([p]) => p.offset);
    expect(offsets).not.toContain(THREAD_PAGE_SIZE);
    expect(offsets).toContain(0);
  });
});
