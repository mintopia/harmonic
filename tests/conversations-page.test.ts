import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

import { ConversationContextDrawer, ConversationsPage } from '../web/src/components/ConversationLauncher.js';
import { isConversationInWorkspace } from '../web/src/components/useConversationDetail.js';
import type { Conversation } from '../web/src/types.js';

const CONVERSATION_LAUNCHER = readFileSync(
  fileURLToPath(new URL('../web/src/components/ConversationLauncher.tsx', import.meta.url)),
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
