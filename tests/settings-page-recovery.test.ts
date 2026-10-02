// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../web/src/components/SettingsPage.js';
import type { AppConfig } from '../web/src/types.js';
import { cleanup, makeConfig, mountComponent } from './component-smoke-harness.js';

const apiMocks = vi.hoisted(() => ({
  configLayers: vi.fn(),
  channels: vi.fn(),
  replaceConfig: vi.fn(),
  updateChannel: vi.fn(),
}));

vi.mock('../web/src/api.js', () => ({ api: apiMocks }));
vi.mock('../web/src/components/SettingsForm.js', () => ({
  SettingsForm: ({ onSave, ctx, error }: {
    onSave: () => void;
    ctx: { config: AppConfig; setConfig: (config: AppConfig) => void; channels: { onToggleEvent: (id: number, event: string) => void } };
    error: string | null;
  }) => createElement('div', null,
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
});

describe('SettingsPage recovery', () => {
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
