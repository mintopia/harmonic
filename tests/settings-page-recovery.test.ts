// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../web/src/components/SettingsPage.js';
import type { AppConfig } from '../web/src/types.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

const apiMocks = vi.hoisted(() => ({
  configLayers: vi.fn(),
  channels: vi.fn(),
  replaceConfig: vi.fn(),
  updateChannel: vi.fn(),
  revertConfig: vi.fn(),
}));

vi.mock('../web/src/api.js', () => ({ api: apiMocks }));
vi.mock('../web/src/components/SettingsForm.js', () => ({
  SettingsForm: ({ onSave, ctx, error, headerActions, children }: {
    headerActions?: ReactNode;
    children?: ReactNode;
    onSave: () => void;
    ctx: { config: AppConfig; setConfig: (config: AppConfig) => void; channels: { onToggleEvent: (id: number, event: string) => void } };
    error: string | null;
  }) => createElement('div', null,
    headerActions,
    children,
    createElement('span', { 'data-testid': 'name' }, ctx.config.name),
    createElement('button', { onClick: onSave }, 'Save'),
    createElement('button', { onClick: () => ctx.setConfig({ ...ctx.config, name: 'Updated' }) }, 'Change setting'),
    createElement('button', { onClick: () => ctx.channels.onToggleEvent(1, 'task.done') }, 'Toggle event'),
    error && createElement('p', { role: 'alert' }, error),
  ),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  const config = makeConfig();
  apiMocks.configLayers.mockResolvedValue({ baseline: config, global: config, harnessPermissionModes: {} });
  apiMocks.channels.mockResolvedValue({ channels: [{ id: 1, name: 'Alerts', type: 'webhook', config: {}, events: [] }] });
  apiMocks.replaceConfig.mockImplementation(async (updated: AppConfig) => updated);
  apiMocks.updateChannel.mockResolvedValue({});
  apiMocks.revertConfig.mockResolvedValue(config);
});

describe('SettingsPage recovery', () => {
  it('keeps settings until a global reset is explicitly confirmed', async () => {
    const onSaved = vi.fn();
    const host = await mountComponent(createElement(SettingsPage, { onSaved }));
    const click = async (text: string) => {
      const button = [...host.querySelectorAll('button')].findLast((button) => button.textContent === text);
      if (!button) throw new Error(`Missing button: ${text}`);
      await act(async () => { button.click(); });
    };
    await click('Change setting');
    await click('Revert all to distributed');
    expect(apiMocks.revertConfig).not.toHaveBeenCalled();
    await click('Cancel');
    expect(host.querySelector('[data-testid="name"]')?.textContent).toBe('Updated');
    await click('Revert all to distributed');
    await click('Revert all to distributed');
    expect(apiMocks.revertConfig).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(makeConfig());
    expect(host.querySelector('dialog')).toBeNull();
  });

  it('shows a reset failure even when no settings have been edited', async () => {
    apiMocks.revertConfig.mockRejectedValueOnce(new Error('reset unavailable'));
    const host = await mountComponent(createElement(SettingsPage, { onSaved: () => {} }));
    await act(async () => { host.querySelector('button')?.click(); });
    const confirm = host.querySelector('dialog button:last-child');
    if (!(confirm instanceof HTMLButtonElement)) throw new Error('Missing reset confirmation');
    await act(async () => { confirm.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('reset unavailable');
  });

  it('shows a retry action when initial settings cannot load', async () => {
    apiMocks.configLayers.mockRejectedValueOnce(new Error('workspace offline'));
    const host = await mountComponent(createElement(SettingsPage, { onSaved: () => {} }));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('workspace offline');
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click(); });
    expect(host.textContent).toContain('Toggle event');
  });

  it('reports a partial save and retries only the remaining channel change', async () => {
    const onSaved = vi.fn();
    const host = await mountComponent(createElement(SettingsPage, { onSaved }));
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Change setting')!.click();
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Toggle event')!.click();
    });
    apiMocks.updateChannel.mockRejectedValueOnce(new Error('channel offline'));

    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Retry to save the remaining channel changes');
    expect(apiMocks.replaceConfig).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledOnce();

    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(apiMocks.updateChannel).toHaveBeenCalledTimes(2);
    expect(apiMocks.replaceConfig).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledOnce();
  });
});
