// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

const { conversations, createConversation, sendTurn } = vi.hoisted(() => ({ conversations: vi.fn(), createConversation: vi.fn(), sendTurn: vi.fn() }));
vi.mock('../web/src/api.js', () => ({ api: { conversations, createConversation, sendTurn } }));

import { ConversationContextDrawer, ConversationsPage } from '../web/src/components/ConversationLauncher.js';
import { isConversationInWorkspace, useConversationDetail } from '../web/src/components/useConversationDetail.js';
import type { Conversation } from '../web/src/types.js';
import { cleanup, makeWorkspace, mountComponent } from './component-smoke-harness.js';

const CONVERSATION_LAUNCHER = readFileSync(
  join(process.cwd(), 'web/src/components/ConversationLauncher.tsx'),
  'utf8',
);

const conversation: Conversation = {
  id: 1,
  title: 'Review the parser',
  workspaceId: 1,
  harness: 'opencode',
  model: 'opencode-large',
  workingDir: '/work',
  permissionMode: 'automatic',
  state: 'active',
  sessionId: null,
  createdAt: 0,
  updatedAt: 0,
  endedAt: null,
  usage: {
    totals: { inputTokens: 12_300, outputTokens: 4_500, cacheReadTokens: 8_000, cacheWriteTokens: 250, totalTokens: 99_999 },
    models: {},
    toolCalls: {},
    source: 'acp',
  },
  cost: null,
  contextTokens: null,
  contextWindow: null,
  cacheWarmSeconds: null,
};

describe('ConversationsPage (#547)', () => {
  afterEach(async () => { await cleanup(); createConversation.mockReset(); sendTurn.mockReset(); });

  it('shows a distinct error state instead of an empty list when conversations fail to load (#654)', async () => {
    conversations.mockRejectedValue(new Error('workspace offline'));
    const workspace = makeWorkspace();

    const host = await mountComponent(
      createElement(ConversationsPage, {
        config: null,
        workspace,
        conversationId: null,
        onConversationChange: () => {},
      }),
    );

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('workspace offline');
    expect(host.textContent).not.toContain('No conversations yet');
  });

  it('provides a dedicated mobile context control in the conversation header (#572)', () => {
    expect(CONVERSATION_LAUNCHER).toContain('aria-label="Open conversation context"');
    expect(CONVERSATION_LAUNCHER).toContain('md:hidden');
  });

  it('renders a conversation rail beside the transcript pane', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationsPage, {
        config: null,
        workspace: null,
        conversationId: null,
        onConversationChange: () => {},
      }),
    );

    expect(html).toContain('aria-label="Conversations"');
    expect(html).toContain('aria-label="Conversation transcript"');
    expect(html).toContain('Select a conversation or start a new one.');
  });

  it('keeps a deep-linked conversation within the active workspace', () => {
    expect(isConversationInWorkspace({ workspaceId: 4 }, 4)).toBe(true);
    expect(isConversationInWorkspace({ workspaceId: 5 }, 4)).toBe(false);
    expect(isConversationInWorkspace({ workspaceId: 4 }, null)).toBe(false);
  });

  it('places full usage and conversation settings in the context drawer', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationContextDrawer, { conversation, events: [], onClose: () => {} }),
    );

    expect(html).toContain('aria-label="Conversation context"');
    expect(html).toContain('I/O tokens');
    expect(html).toContain('16,800');
    expect(html).toContain('12.3k');
    expect(html).toContain('4.5k');
    expect(html).toContain('Cache read');
    expect(html).toContain('Cache write');
    expect(html).toContain('Model');
    expect(html).toContain('Directory');
    expect(html).toContain('Permissions');
    expect(html).toContain('Automatic');
    expect(html).not.toContain('99,999');
  });

  it('keeps a failed first turn in the new composer and reuses its created conversation on retry', async () => {
    createConversation.mockResolvedValue(conversation);
    sendTurn.mockRejectedValueOnce(new Error('send failed')).mockResolvedValue({ queued: false });
    const openConversation = vi.fn();
    const noop = () => {};
    let current: ReturnType<typeof useConversationDetail> | undefined;
    function Probe() {
      const detail = useConversationDetail(null, {
        workspaceId: 1,
        upsertConversationInList: noop,
        removeConversationFromList: noop,
        openConversation,
        openList: noop,
        pendingPermission: null,
        clearPendingPermission: noop,
      });
      useEffect(() => { current = detail; }, [detail]);
      return null;
    }
    await mountComponent(createElement(Probe));
    const fields = { harness: 'opencode', model: 'opencode-large', permissionMode: 'ask' as const };
    await act(async () => { await expect(current?.actions.send(fields, 'Review this patch')).rejects.toThrow('send failed'); });
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => { await current?.actions.send(fields, 'Review this patch'); });
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(openConversation).toHaveBeenCalledWith(1);
  });
});
