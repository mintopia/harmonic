// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

import { PromptsTab } from '../web/src/components/prompts/PromptsTab.js';
import type { GlobalRenderCtx, RenderCtx, WorkspaceRenderCtx } from '../web/src/components/settings-schema.js';
import type { AppConfig, Workspace } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeWorkspace, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

const BASELINE = makeConfig({ drive: { ...makeConfig().drive, prompt: 'drive text' } });

function GlobalHarness({ errors = {}, onTab }: { errors?: Record<string, string>; onTab?: (tab: string) => void }) {
  const [config, setConfig] = useState<AppConfig>(BASELINE);
  const ctx: GlobalRenderCtx = {
    surface: 'global',
    config,
    baseline: BASELINE,
    setConfig,
    errors,
    harnessPermissionModes: {},
    channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
    onTab,
  };
  return createElement(PromptsTab, { ctx });
}

function WorkspaceHarness() {
  const [workspace, setWorkspace] = useState<Workspace>(makeWorkspace());
  const ctx: WorkspaceRenderCtx = {
    surface: 'workspace',
    config: BASELINE,
    workspace,
    pristineWorkspace: workspace,
    setWorkspace,
    errors: {},
    blockedByRunningTask: false,
    onRequestDelete: () => {},
  };
  const element: RenderCtx = ctx;
  return createElement(PromptsTab, { ctx: element });
}

const tab = (host: HTMLElement, name: RegExp) => [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => name.test(t.textContent ?? ''));
const card = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => b.querySelector('span > span')?.textContent === label);

async function click(el: Element | undefined | null) {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
  });
}

async function key(el: Element | null | undefined, k: string) {
  await act(async () => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await flush();
  });
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  });
}

describe('PromptsTab', () => {
  it('moves between prompts with arrow keys, Home and End', async () => {
    const host = await mountComponent(createElement(GlobalHarness));
    const list = host.querySelector('[role=tablist]');
    expect(list?.getAttribute('aria-orientation')).toBe('vertical');
    expect(tab(host, /Implementation turn/)?.getAttribute('aria-selected')).toBe('true');
    await key(tab(host, /Implementation turn/), 'ArrowDown');
    expect(tab(host, /Nudges/)?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(host, /Nudges/));
    await key(tab(host, /Nudges/), 'End');
    expect(tab(host, /Critic review/)?.getAttribute('aria-selected')).toBe('true');
    await key(tab(host, /Critic review/), 'Home');
    expect(tab(host, /Implementation turn/)?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(tab(host, /Implementation turn/)?.id);
  });

  it('expands a part, focuses its textarea, and collapses on Escape back to the header', async () => {
    const host = await mountComponent(createElement(GlobalHarness));
    const header = card(host, 'Drive prompt');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    await click(header);
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    const area = host.querySelector<HTMLTextAreaElement>('textarea#settings-drive-prompt');
    expect(area).not.toBeNull();
    expect(document.activeElement).toBe(area);
    expect(document.getElementById(header?.getAttribute('aria-controls') ?? '')?.getAttribute('role')).toBe('region');
    await key(area, 'Escape');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(header);
  });

  it('updates the Compiled preview as the text is typed and reverts to the baseline', async () => {
    const host = await mountComponent(createElement(GlobalHarness));
    await click(tab(host, /Implementation turn/));
    const preview = () => host.querySelector('section[aria-label="Compiled preview"]')?.textContent ?? '';
    await click(host.querySelector('[role=radio][aria-checked=false]'));
    expect(preview()).toContain('drive text');
    await click(card(host, 'Drive prompt'));
    const area = host.querySelector<HTMLTextAreaElement>('textarea#settings-drive-prompt');
    if (!area) throw new Error('no textarea');
    await type(area, 'typed replacement');
    expect(preview()).toContain('typed replacement');
    expect(host.textContent).toContain('1 modified');
    const revert = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Revert');
    await click(revert);
    expect(preview()).toContain('drive text');
    expect(host.querySelector<HTMLTextAreaElement>('textarea#settings-drive-prompt')?.value).toBe('drive text');
  });

  it('shows the failing part expanded with a Fix tag when the server rejects it', async () => {
    const host = await mountComponent(createElement(GlobalHarness, { errors: { 'merge.conflictPrompt': 'Required' } }));
    expect(tab(host, /Merge conflicts/)?.getAttribute('aria-selected')).toBe('true');
    expect(tab(host, /Merge conflicts/)?.textContent).toContain('1 error');
    const header = card(host, 'Merge conflict resolver');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(header?.textContent).toContain('Fix');
    expect(host.querySelector('textarea#settings-merge-conflict-prompt')).not.toBeNull();
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Required');
  });

  it('shows the Epic resolve prompt read-only on a Workspace', async () => {
    const host = await mountComponent(createElement(WorkspaceHarness));
    await click(tab(host, /Epic verification fix/));
    await click(card(host, 'Epic resolve prompt'));
    expect(host.textContent).toContain('Global only — not overridable per Workspace');
    expect(host.querySelector('textarea#workspace-epic-resolve-prompt')).toBeNull();
    await click(card(host, 'Epic verification resolver suffix'));
    expect(host.querySelector('textarea#workspace-epic-resolve-suffix')).not.toBeNull();
  });

  it('sends the critic card to the Verification tab', async () => {
    const onTab = vi.fn();
    const host = await mountComponent(createElement(GlobalHarness, { onTab }));
    await click(tab(host, /Critic review/));
    expect(card(host, 'Critic prompt')).toBeUndefined();
    await click([...host.querySelectorAll('button')].find((b) => /Open Verification settings/.test(b.textContent ?? '')));
    expect(onTab).toHaveBeenCalledWith('verification');
  });

  it('jumps from a search result to the part, switching prompt', async () => {
    const host = await mountComponent(createElement(GlobalHarness));
    const input = host.querySelector<HTMLInputElement>('input[type=search]');
    if (!input) throw new Error('no search');
    await type(input, 'commit nudge');
    const result = [...host.querySelectorAll<HTMLButtonElement>('ul[aria-label="Search results"] button')][0];
    expect(result?.textContent).toContain('Commit nudge');
    await click(result);
    expect(tab(host, /Nudges/)?.getAttribute('aria-selected')).toBe('true');
    expect(card(host, 'Commit nudge')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('');
  });

  it('clears the search with Escape', async () => {
    const host = await mountComponent(createElement(GlobalHarness));
    const input = host.querySelector<HTMLInputElement>('input[type=search]');
    if (!input) throw new Error('no search');
    await type(input, 'zzzz');
    expect(host.querySelector('[role=status]')?.textContent).toContain('Nothing matches');
    await key(input, 'Escape');
    expect(host.querySelector<HTMLInputElement>('input[type=search]')?.value).toBe('');
  });
});
