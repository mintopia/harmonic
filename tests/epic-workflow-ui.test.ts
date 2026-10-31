// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { EpicMeta } from '../web/src/components/EpicPage.js';
import { EpicWorkflowEditor, WorkflowLabelsEditor } from '../web/src/components/WorkflowLabelsEditor.js';
import type { Epic } from '../web/src/epic-model.js';
import { cleanup, flush, makeConfig, mountComponent } from './component-smoke-harness.js';

const entry = (name: string, subject: 'ticket' | 'epic', version: number) => ({
  name, description: '', subject, bundled: false, version, inUse: { tickets: 0, workspaces: 0 }, assignedAs: [],
});
const library = [entry('Plain ticket', 'ticket', 2), entry('Migrated Epic (global)', 'epic', 1)];

beforeEach(() => {
  vi.spyOn(api, 'workflows').mockResolvedValue({ workflows: library, total: library.length });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

const optionTexts = (el: Element | null) => [...(el as HTMLSelectElement).options].map((o) => o.textContent);

describe('Epic workflow settings', () => {
  it('global card lists only Epic workflows with versions', async () => {
    const host = await mountComponent(createElement(EpicWorkflowEditor, { surface: 'global', value: null, globalValue: null, onChange: () => {} }));
    expect(optionTexts(host.querySelector('#settings-epic-workflow'))).toEqual(['None', 'Migrated Epic (global) · v1']);
    expect(host.textContent).toContain('Used when the Workspace has no Epic workflow of its own.');
  });

  it('workspace card inherits the global name and saves the choice', async () => {
    const onChange = vi.fn();
    const host = await mountComponent(createElement(EpicWorkflowEditor, { surface: 'workspace', value: null, globalValue: 'Migrated Epic (global)', onChange }));
    const select = host.querySelector<HTMLSelectElement>('#workspace-epic-workflow')!;
    expect(optionTexts(select)).toEqual(['Use global default · Migrated Epic (global)', 'Migrated Epic (global) · v1']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'Migrated Epic (global)');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
    expect(onChange).toHaveBeenCalledWith('Migrated Epic (global)');
  });

  it('ticket selectors exclude Epic workflows', async () => {
    const host = await mountComponent(createElement(WorkflowLabelsEditor, { config: makeConfig(), onChange: () => {} }));
    const names = optionTexts(host.querySelector('#settings-workflow')).join('|');
    expect(names).toContain('Plain ticket · v2');
    expect(names).not.toContain('Migrated Epic');
  });
});

describe('Epic page Workflow line', () => {
  const epic = (workflow: Epic['workflow']) =>
    ({ memberCount: 2, foldedCount: 1, baseBranch: 'develop', integration: { branch: 'epic/1' }, dependsOn: [], createdAt: 0, updatedAt: null, workflow }) as unknown as Epic;

  it.each([
    ['workspace', 'Migrated Epic (harmonic)v1— Workspace Epic workflow'],
    ['global', 'Migrated Epic (harmonic)v1— global Epic workflow'],
  ] as const)('shows the %s source', async (chosen, text) => {
    const host = await mountComponent(createElement(EpicMeta, { epic: epic({ name: 'Migrated Epic (harmonic)', version: 1, chosen }), stats: null }));
    const dd = [...host.querySelectorAll('dt')].find((d) => d.textContent === 'Workflow')!.parentElement!;
    expect(dd.textContent?.replace(/\s+/g, '').replace('Workflow', '')).toBe(text.replace(/\s+/g, ''));
  });

  it('omits the row without a workflow', async () => {
    const host = await mountComponent(createElement(EpicMeta, { epic: epic(null), stats: null }));
    expect(host.textContent).not.toContain('Workflow');
  });
});
