import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_ATTENTION } from '../web/src/conversation-attention-model.js';
import { ConversationList } from '../web/src/components/ConversationList.js';
import type { Conversation } from '../web/src/types.js';

const handlers = {
  onSelect: () => {},
  onNew: () => {},
  onDelete: () => {},
  onToggleExpand: () => {},
  onClose: () => {},
};

const COMPOSER = readFileSync(
  fileURLToPath(new URL('../web/src/components/conversation/Composer.tsx', import.meta.url)),
  'utf8',
);

describe('conversation vocabulary UI (#546)', () => {
  it('uses product names in conversation metadata', () => {
    const conversation: Conversation = {
      id: 1,
      title: 'Review the parser',
      workspaceId: 1,
      harness: 'opencode',
      model: 'opencode-large',
      workingDir: '/work',
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

    const html = renderToStaticMarkup(
      createElement(ConversationList, { conversations: [conversation], attention: NO_ATTENTION, expanded: false, ...handlers }),
    );

    expect(html).toContain('OpenCode');
    expect(html).toContain('OpenCode · opencode-large');
  });

  it('uses conversation language in the empty state', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationList, { conversations: [], attention: NO_ATTENTION, expanded: false, ...handlers }),
    );

    expect(html).toContain('Start a conversation to explore a repo or drive changes turn by turn, live.');
    expect(html).not.toMatch(/agent|chat|session|thread/i);
  });

  it('addresses the selected responder by product name in the composer', () => {
    expect(COMPOSER).toContain('Message ${providerLabel(harness)}…');
    expect(COMPOSER).not.toContain('Message the agent…');
  });
});
