// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../web/src/components/conversation/Composer.js';
import type { Conversation } from '../web/src/types.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

const conversation: Conversation = {
  id: 1,
  title: null,
  workspaceId: 1,
  harness: 'codex',
  model: 'gpt-5.6',
  workingDir: '/work',
  permissionMode: 'ask',
  state: 'active',
  sessionId: 'session-1',
  createdAt: 0,
  updatedAt: 0,
  endedAt: null,
  usage: null,
  cost: null,
  contextTokens: null,
  contextWindow: null,
  cacheWarmSeconds: null,
  commandPrefix: '$',
  commands: [
    { name: 'help', description: 'Show help' },
    { name: 'status', description: 'Show status' },
  ],
};

const config = makeConfig({
  harnesses: {
    codex: { command: 'codex', args: [], env: {}, models: [{ id: 'gpt-5.6' }], defaultModel: 'gpt-5.6', cacheWarmSeconds: 300 },
  },
  chat: { harness: 'codex', model: 'gpt-5.6' },
});

afterEach(cleanup);

async function type(textarea: HTMLTextAreaElement, value: string, caret = value.length) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(textarea, value);
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  });
}

describe('Composer command picker (#613)', () => {
  it('filters advertised commands, selects them by keyboard, and never sends the selection', async () => {
    const onSend = vi.fn(async () => ({ queued: false }));
    const host = await mountComponent(
      createElement(Composer, { config, workspace: null, conversation, events: [], expanded: false, onSend }),
    );
    const textarea = host.querySelector('textarea');
    if (!textarea) throw new Error('Composer textarea is missing');

    await type(textarea, 'src/foo');
    expect(host.querySelector('[role=listbox]')).toBeNull();

    await type(textarea, '$he');
    expect(host.querySelector('[role=listbox]')?.textContent).toContain('Show help');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');

    await key(textarea, 'ArrowDown');
    await key(textarea, 'Enter');
    expect(textarea.value).toBe('$help ');
    expect(onSend).not.toHaveBeenCalled();

    await type(textarea, '$st');
    await key(textarea, 'ArrowDown');
    await key(textarea, 'Tab');
    expect(textarea.value).toBe('$status ');
    expect(onSend).not.toHaveBeenCalled();

  });

  it('closes on Escape without sending, then sends Enter after the menu is closed', async () => {
    const onSend = vi.fn(async () => ({ queued: false }));
    const host = await mountComponent(
      createElement(Composer, { config, workspace: null, conversation, events: [], expanded: false, onSend }),
    );
    const textarea = host.querySelector('textarea');
    if (!textarea) throw new Error('Composer textarea is missing');

    await type(textarea, '$status');
    await key(textarea, 'Escape');
    expect(host.querySelector('[role=listbox]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    await key(textarea, 'Enter');
    expect(onSend).toHaveBeenCalledWith(
      { harness: 'codex', model: 'gpt-5.6', permissionMode: 'ask' },
      '$status',
    );
  });
});
