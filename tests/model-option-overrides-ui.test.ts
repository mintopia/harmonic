// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { ModelOptionOverrides, availableOptions } from '../web/src/components/ticket/ModelOptionOverrides.js';
import type { ModelOption } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const opt = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({ id, harness: 'claude', model: 'claude-sonnet-5', description: id, ...over });
const cfg = () => {
  const base = makeConfig();
  return { ...base, modelOptions: [opt('cheap-fix'), opt('opus-deep')] };
};
const ws = makeWorkspace({ modelOptions: [{ kind: 'local', enabled: true, modelOption: opt('deep-dive') }, { kind: 'global', ref: 'cheap-fix', enabled: true }] });

beforeEach(() => {
  vi.spyOn(api, 'config').mockResolvedValue(cfg());
  vi.spyOn(api, 'workspaces').mockResolvedValue({ workspaces: [ws], total: 1 });
  vi.spyOn(api, 'harnessProviders').mockResolvedValue({ providers: [] });
});

const mount = (task = makeTask({ state: 'ready', workspaceId: ws.id })) => mountComponent(createElement(ModelOptionOverrides, { task }));
const select = (host: HTMLElement, label: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const choose = async (el: HTMLSelectElement, value: string) => {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  });
};

describe('availableOptions', () => {
  it('follows the overlay order, drops disabled globals and appends unnamed globals', () => {
    expect(availableOptions(ws, cfg()).map((o) => o.id)).toEqual(['deep-dive', 'cheap-fix', 'opus-deep']);
    const off = makeWorkspace({ modelOptions: [{ kind: 'global', ref: 'cheap-fix', enabled: false }] });
    expect(availableOptions(off, cfg()).map((o) => o.id)).toEqual(['opus-deep']);
  });
});

describe('Model Option overrides panel', () => {
  it('offers only defined codes and adds a row with that option\'s route', async () => {
    const host = await mount();
    const add = select(host, 'Add override');
    expect(Array.from(add.options).map((o) => o.value).filter(Boolean)).toEqual(['deep-dive', 'cheap-fix', 'opus-deep']);
    await choose(add, 'deep-dive');
    expect(host.querySelector('code')?.textContent).toBe('deep-dive');
    expect(select(host, 'Harness for deep-dive').value).toBe('claude');
    expect(Array.from(select(host, 'Add override').options).map((o) => o.value)).not.toContain('deep-dive');
  });

  it('changing Harness resets Model to that Harness default, then saves the whole list', async () => {
    const base = cfg();
    const config = { ...base, harnesses: { ...base.harnesses, codex: { ...base.harnesses.claude!, defaultModel: 'gpt-5-codex', models: [{ ...base.harnesses.claude!.models[0]!, id: 'gpt-5-codex' }] } } };
    const other = 'codex';
    vi.spyOn(api, 'config').mockResolvedValue(config);
    const update = vi.spyOn(api, 'updateTask').mockResolvedValue(makeTask());
    const host = await mount(makeTask({ state: 'ready', workspaceId: ws.id, modelOptionOverrides: [{ id: 'cheap-fix', harness: 'claude', model: 'claude-sonnet-5' }] }));
    await choose(select(host, 'Harness for cheap-fix'), other);
    await act(async () => {
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save overrides')!.click();
      await flush();
    });
    expect(update).toHaveBeenCalledWith(expect.any(Number), { modelOptionOverrides: [{ id: 'cheap-fix', harness: other, model: config.harnesses[other]!.defaultModel }] });
  });

  it('shows the server validation error inline on the failing row', async () => {
    vi.spyOn(api, 'updateTask').mockRejectedValue(new Error("modelOptionOverrides.0.model: model 'gpt-9' is not in the claude model catalog"));
    const host = await mount(makeTask({ state: 'ready', workspaceId: ws.id, modelOptionOverrides: [{ id: 'cheap-fix', harness: 'claude', model: 'claude-sonnet-5' }] }));
    await choose(select(host, 'Add override'), 'deep-dive');
    await act(async () => {
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save overrides')!.click();
      await flush();
    });
    expect(host.querySelector('li [role="alert"]')?.textContent).toContain('gpt-9');
  });

  it('is read-only when the Task is not editable', async () => {
    const host = await mount(makeTask({ state: 'working', workspaceId: ws.id, modelOptionOverrides: [{ id: 'cheap-fix', harness: 'claude', model: 'claude-sonnet-5' }] }));
    expect(host.querySelector('code')?.textContent).toBe('cheap-fix');
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
  });

  it('renders nothing for a locked Ticket with no overrides', async () => {
    const host = await mount(makeTask({ state: 'working', workspaceId: ws.id }));
    expect(host.textContent).toBe('');
  });
});
