import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

import { ConversationsPage } from '../web/src/components/ConversationLauncher.js';

describe('ConversationsPage (#547)', () => {
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
});
