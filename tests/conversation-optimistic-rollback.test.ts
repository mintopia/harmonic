// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { conversation, conversationEvents, sendTurn } = vi.hoisted(() => ({
  conversation: vi.fn(),
  conversationEvents: vi.fn(),
  sendTurn: vi.fn(),
}));

vi.mock('../web/src/api.js', () => ({
  api: {
    conversation,
    conversationEvents,
    sendTurn,
  },
}));

import { useConversationDetail } from '../web/src/components/useConversationDetail.js';

const openConversation: Conversation = {
  id: 1,
  title: null,
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  workingDir: '/work',
  permissionMode: 'automatic',
  state: 'active',
  sessionId: null,
  createdAt: 0,
  updatedAt: 0,
  endedAt: null,
  usage: null,
  cost: null,
  contextTokens: null,
  contextWindow: null,
  cacheWarmSeconds: null,
};

const noop = () => {};
const options = {
  workspaceId: 1,
  upsertConversationInList: noop,
  removeConversationFromList: noop,
  openConversation: noop,
  openList: noop,
  pendingPermission: null,
  clearPendingPermission: noop,
} as const;

function Harness({ onSendError }: { onSendError: (e: unknown) => void }) {
  const { events, actions } = useConversationDetail(1, options);
  return createElement(
    'div',
    null,
    createElement('button', {
      'data-testid': 'send',
      onClick: () => {
        actions
          .send({ harness: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'automatic' }, 'steer while running')
          .catch(onSendError);
      },
    }),
    createElement(
      'ul',
      { 'data-testid': 'events' },
      events.map((e) => createElement('li', { key: e.id }, JSON.stringify(e.payload))),
    ),
  );
}

afterEach(cleanup);

describe('useConversationDetail optimistic steering rollback (#653)', () => {
  it('removes the optimistic pending turn and rethrows when sendTurn rejects', async () => {
    conversation.mockResolvedValue(openConversation);
    conversationEvents.mockResolvedValue({ events: [], total: 0 });
    let rejectSendTurn: (e: unknown) => void = () => {};
    sendTurn.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSendTurn = reject;
        }),
    );

    const errors: unknown[] = [];
    const host = await mountComponent(createElement(Harness, { onSendError: (e) => errors.push(e) }));

    const button = host.querySelector('[data-testid="send"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(host.textContent).toContain('steer while running');

    await act(async () => {
      rejectSendTurn(new Error('network down'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('steer while running');
    expect(host.querySelector('[data-testid="events"]')?.children.length).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
