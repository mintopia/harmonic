// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

import { PromptsTab } from '../web/src/components/prompts/PromptsTab.js';
import type { GlobalRenderCtx } from '../web/src/components/settings-schema.js';
import { cleanup, flush, makeConfig, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(cleanup);

const config = makeConfig();
const ctx: GlobalRenderCtx = {
  surface: 'global',
  config,
  baseline: config,
  setConfig: () => {},
  errors: {},
  harnessPermissionModes: {},
  channels: { list: [], onToggleEvent: () => {}, onCreated: () => {}, onDeleted: () => {} },
};

async function click(el: Element | undefined) {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
  });
}

async function openPartEditor(host: HTMLElement, tabName: RegExp, label: string) {
  await click([...host.querySelectorAll('[role=tab]')].find((t) => tabName.test(t.textContent ?? '')));
  await click([...host.querySelectorAll('button[aria-expanded]')].find((b) => b.querySelector('span > span')?.textContent === label));
}

describe('Prompts tab resolver fields', () => {
  it('renders each resolver and nudge prompt as an editable textarea', async () => {
    const host = await mountComponent(createElement(PromptsTab, { ctx }));
    const parts: [RegExp, string, string][] = [
      [/Nudges/, 'Commit nudge', 'settings-commit-nudge'],
      [/Implementation/, 'Peer line', 'settings-fragment-peer-line'],
      [/Merge conflicts/, 'Merge conflict resolver', 'settings-merge-conflict-prompt'],
      [/Merge conflicts/, 'Epic merge conflict resolver', 'settings-epic-conflict-prompt'],
      [/Merge conflicts/, 'Epic refresh resolver', 'settings-epic-refresh-prompt'],
      [/Epic verification fix/, 'Epic resolve prompt', 'settings-epic-resolve-prompt'],
      [/Epic verification fix/, 'Epic verification resolver suffix', 'settings-epic-resolve-suffix'],
    ];
    for (const [tab, label, id] of parts) {
      await openPartEditor(host, tab, label);
      expect(host.querySelector(`textarea#${id}`), id).not.toBeNull();
    }
  });

  it('lists the placeholders each merge prompt accepts', async () => {
    const host = await mountComponent(createElement(PromptsTab, { ctx }));
    await openPartEditor(host, /Merge conflicts/, 'Merge conflict resolver');
    const text = host.textContent ?? '';
    for (const token of ['{turn}', '{taskBranch}', '{baseBranch}', '{paths}', '{fragment.conflictResolution}']) {
      expect(text).toContain(token);
    }
    await openPartEditor(host, /Epic verification fix/, 'Epic verification resolver suffix');
    expect(host.querySelector('[role=region][aria-label="Epic verification resolver suffix"]')?.textContent).toContain('{branch}');
  });
});
