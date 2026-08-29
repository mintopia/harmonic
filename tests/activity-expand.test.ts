// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityView } from '../web/src/components/ActivityView.js';
import type { ActivityProcess } from '../web/src/types.js';

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function process(attemptId: number, title: string): ActivityProcess {
  return {
    type: 'attempt',
    attemptId,
    conversationId: null,
    taskId: attemptId,
    title,
    workspaceId: 1,
    workspaceName: 'Workspace',
    harness: 'claude',
    model: 'claude-test',
    state: 'running',
    isolation: 'worktree',
    startedAt: Date.now(),
    trackerRef: null,
    trackerUrl: null,
    escalated: false,
    usage: null,
    contextTokens: null,
    contextWindow: null,
    activity: null,
    tree: {
      id: `session-${attemptId}`,
      name: title,
      model: 'claude-test',
      usage,
      contextTokens: null,
      status: 'active',
      depth: 0,
      toolUseId: null,
      children: [],
    },
    cost: null,
  };
}

class IdleWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {}

  close() {}
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('Activity process-tree expansion (issue #322)', () => {
  it('keeps two active task trees open independently', async () => {
    const processes = [process(1, 'First task'), process(2, 'Second task')];
    vi.stubGlobal('WebSocket', IdleWebSocket);
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/api/activity') return new Response(JSON.stringify({ processes }));
      if (path.endsWith('/log')) return new Response(JSON.stringify({ status: 'unavailable' }));
      throw new Error(`unexpected request: ${path}`);
    });

    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(ActivityView, { config: null }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const toggles = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Expand process tree"]')];
    expect(toggles).toHaveLength(2);
    await act(async () => {
      toggles[0]?.click();
      toggles[1]?.click();
    });

    expect(host.textContent?.match(/Process tree/g)).toHaveLength(2);
  });
});
