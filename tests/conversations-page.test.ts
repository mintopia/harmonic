// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

const { conversations } = vi.hoisted(() => ({ conversations: vi.fn() }));
vi.mock('../web/src/api.js', () => ({ api: { conversations } }));

import { ConversationContextDrawer, ConversationsPage } from '../web/src/components/ConversationLauncher.js';
import { isConversationInWorkspace } from '../web/src/components/useConversationDetail.js';
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
  afterEach(cleanup);

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
});
