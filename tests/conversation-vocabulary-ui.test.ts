import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { baselineConfig } from '../src/config.js';
import { NO_ATTENTION } from '../web/src/conversation-attention-model.js';
import { ConversationList } from '../web/src/components/ConversationList.js';
import { Composer } from '../web/src/components/conversation/Composer.js';
import type { Conversation } from '../web/src/types.js';

const handlers = {
  onSelect: () => {},
  onNew: () => {},
  onDelete: () => {},
  onExpand: () => {},
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
      permissionMode: 'ask',
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
      createElement(ConversationList, { conversations: [conversation], attention: NO_ATTENTION, ...handlers }),
    );

    expect(html).toContain('OpenCode');
    expect(html).toContain('OpenCode · opencode-large');
  });

  it('uses conversation language in the empty state', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationList, { conversations: [], attention: NO_ATTENTION, ...handlers }),
    );

    expect(html).toContain('Start a conversation to explore a repo or drive changes turn by turn, live.');
    expect(html).not.toMatch(/agent|chat|session|thread/i);
  });

  it('addresses the stored responder by product name in the composer prompt', () => {
    const config = baselineConfig();
    config.chat = { harness: 'codex', model: config.harnesses.codex.defaultModel };
    const conversation: Conversation = {
      id: 1,
      title: null,
      workspaceId: 1,
      harness: 'opencode',
      model: config.harnesses.opencode.defaultModel,
      workingDir: '/work',
      permissionMode: 'ask',
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
      createElement(Composer, {
        config,
        workspace: null,
        conversation,
        events: [],
        expanded: false,
        onSend: async () => ({ queued: false }),
      }),
    );

    expect(html).toContain('placeholder="Message OpenCode… (Enter to send, Shift+Enter for a newline)"');
    expect(html).not.toContain('Message Codex…');
    expect(html).not.toContain('Message the agent…');
  });

  it('keeps the composer open on an ended conversation that can resume', () => {
    const config = baselineConfig();
    const conversation: Conversation = {
      id: 1,
      title: null,
      workspaceId: 1,
      harness: 'opencode',
      model: config.harnesses.opencode.defaultModel,
      workingDir: '/work',
      permissionMode: 'ask',
      state: 'ended',
      sessionId: 'sess-1',
      createdAt: 0,
      updatedAt: 0,
      endedAt: 1,
      usage: null,
      cost: null,
      contextTokens: null,
      contextWindow: null,
      cacheWarmSeconds: null,
    };

    const html = renderToStaticMarkup(
      createElement(Composer, {
        config,
        workspace: null,
        conversation,
        events: [],
        expanded: false,
        onSend: async () => ({ queued: false }),
      }),
    );

    expect(html).toContain('placeholder="Message OpenCode… (Enter to send, Shift+Enter for a newline)"');
    expect(html).not.toContain('Conversation ended.');
    expect(html).toContain('commands');
  });

  it('uses a touch-sized action for stopping a running turn (#572)', () => {
    expect(COMPOSER).toContain('aria-label={text.trim() ? \'Interrupt current turn\' : \'Stop current turn\'}');
    expect(COMPOSER).toContain('${touchTarget}');
  });
});
