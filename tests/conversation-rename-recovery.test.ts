// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationsPage } from '../web/src/components/ConversationLauncher.js';
import type { Conversation } from '../web/src/types.js';
import { cleanup, makeWorkspace, mountComponent } from './component-smoke-harness.js';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));
const apiMocks = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversation: vi.fn(),
  conversationEvents: vi.fn(),
  renameConversation: vi.fn(),
}));
vi.mock('../web/src/api.js', () => ({ api: apiMocks }));
vi.mock('../web/src/toast.js', () => ({ toastError: vi.fn() }));

const conversation: Conversation = {
  id: 1,
  title: 'Original title',
  workspaceId: 1,
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  workingDir: '/tmp/ws1',
  permissionMode: 'ask',
  state: 'ended',
  sessionId: null,
  createdAt: 0,
  updatedAt: 0,
  endedAt: 0,
  usage: { totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, models: {}, toolCalls: {}, source: 'acp' },
  cost: null,
  contextTokens: null,
  contextWindow: null,
  cacheWarmSeconds: null,
};

afterEach(async () => { await cleanup(); vi.clearAllMocks(); });

describe('conversation rename', () => {
  it('keeps the edited title after a failed save and closes after a successful retry', async () => {
    apiMocks.conversations.mockResolvedValue({ conversations: [conversation] });
    apiMocks.conversation.mockResolvedValue(conversation);
    apiMocks.conversationEvents.mockResolvedValue({ events: [] });
    apiMocks.renameConversation.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...conversation, title: 'New title' });
    const host = await mountComponent(createElement(ConversationsPage, {
      config: null,
      workspace: makeWorkspace(),
      conversationId: 1,
      onConversationChange: () => {},
    }));

    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Rename conversation"]')!.click(); });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Conversation title"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'New title');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Save title"]')!.click(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Conversation title"]')?.value).toBe('New title');
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Save title"]')!.click(); });
    expect(host.querySelector('input[aria-label="Conversation title"]')).toBeNull();
    expect(host.textContent).toContain('New title');
    expect(apiMocks.renameConversation).toHaveBeenCalledTimes(2);
  });
});
