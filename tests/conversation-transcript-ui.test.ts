// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

import { Transcript } from '../web/src/components/conversation/Transcript.js';
import type { ConversationEvent } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const tool = (id: number, toolCallId: string, payload: Record<string, unknown>): ConversationEvent => ({
  id,
  conversationId: 1,
  seq: id,
  ts: id,
  type: 'session_update',
  payload: { sessionUpdate: 'tool_call', toolCallId, ...payload },
});

afterEach(cleanup);

describe('Conversation transcript live activity (#551)', () => {
  it('keeps the current tool distinct from completed transcript history', async () => {
    const host = await mountComponent(
      createElement(Transcript, {
        conversation: null,
        events: [
          tool(1, 'read', { title: 'Read src/app.ts', status: 'completed' }),
          tool(2, 'test', { title: 'Run npm test', status: 'pending' }),
        ],
      }),
    );

    expect(host.textContent).toContain('Running');
    expect(host.textContent).toContain('Run npm test');
  });

  it('offers an explicit jump after the reader scrolls away from the live edge', async () => {
    const host = await mountComponent(createElement(Transcript, { conversation: null, events: [] }));
    const pane = host.firstElementChild;
    if (!(pane instanceof HTMLDivElement)) throw new Error('Transcript scroll pane is missing');
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 100;

    await act(async () => {
      pane.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const jump = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Jump to latest'));
    expect(jump).toBeDefined();

    await act(async () => {
      jump?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pane.scrollTop).toBe(500);
  });
});
