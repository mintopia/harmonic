// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

const deleteChannel = vi.fn();
const deletePermissionRule = vi.fn();
const permissionRules = vi.fn();
const toastError = vi.fn();

vi.mock('../web/src/api.js', () => ({
  api: {
    deleteChannel: (...a: unknown[]) => deleteChannel(...a),
    deletePermissionRule: (...a: unknown[]) => deletePermissionRule(...a),
    permissionRules: () => permissionRules(),
  },
}));
vi.mock('../web/src/toast.js', () => ({ toastError: (e: unknown) => toastError(e) }));

const { ChannelsSection } = await import('../web/src/components/Channels.js');
const { PermissionRules } = await import('../web/src/components/PermissionRules.js');

const channel = { id: 7, name: 'ops', type: 'webhook', config: { url: 'https://x.test' }, events: [] } as never;

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button ${text}`);
  return b as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  permissionRules.mockResolvedValue({ rules: [{ id: 3, kind: 'bash', workingDir: '/w' }], total: 1 });
});
afterEach(cleanup);

describe('channel delete', () => {
  const mount = (onDeleted = vi.fn()) =>
    mountComponent(createElement(ChannelsSection, { channels: [channel], onToggleEvent: vi.fn(), onCreated: vi.fn(), onDeleted }));

  it('asks first and cancel keeps the channel', async () => {
    const host = await mount();
    await click(button(host, 'Delete'));
    expect(document.body.textContent).toContain('Delete "ops"?');
    expect(deleteChannel).not.toHaveBeenCalled();
    await click(button(document.body, 'Cancel'));
    expect(deleteChannel).not.toHaveBeenCalled();
  });

  it('confirm deletes and notifies the parent', async () => {
    deleteChannel.mockResolvedValue({});
    const onDeleted = vi.fn();
    const host = await mount(onDeleted);
    await click(button(host, 'Delete'));
    await click(document.querySelector('dialog button:last-child') as HTMLElement);
    expect(deleteChannel).toHaveBeenCalledWith(7);
    expect(onDeleted).toHaveBeenCalledWith(7);
  });

  it('a failed delete shows an error toast', async () => {
    const err = new Error('boom');
    deleteChannel.mockRejectedValue(err);
    const onDeleted = vi.fn();
    const host = await mount(onDeleted);
    await click(button(host, 'Delete'));
    await click(document.querySelector('dialog button:last-child') as HTMLElement);
    expect(toastError).toHaveBeenCalledWith(err);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('permission rule revoke', () => {
  it('asks first and cancel keeps the rule', async () => {
    const host = await mountComponent(createElement(PermissionRules));
    await click(button(host, 'Revoke'));
    expect(deletePermissionRule).not.toHaveBeenCalled();
    await click(button(document.body, 'Cancel'));
    expect(deletePermissionRule).not.toHaveBeenCalled();
  });

  it('a failed revoke shows an error toast', async () => {
    const err = new Error('boom');
    deletePermissionRule.mockRejectedValue(err);
    const host = await mountComponent(createElement(PermissionRules));
    await click(button(host, 'Revoke'));
    await click(document.querySelector('dialog button:last-child') as HTMLElement);
    expect(deletePermissionRule).toHaveBeenCalledWith(3);
    expect(toastError).toHaveBeenCalledWith(err);
  });
});
