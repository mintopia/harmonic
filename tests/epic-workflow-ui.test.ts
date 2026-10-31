// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { EpicMeta, EpicWorkflowLine } from '../web/src/components/EpicPage.js';
import { EpicWorkflowEditor, WorkflowLabelsEditor } from '../web/src/components/WorkflowLabelsEditor.js';
import type { Epic } from '../web/src/epic-model.js';
import { cleanup, flush, makeConfig, mountComponent } from './component-smoke-harness.js';

const entry = (name: string, subject: 'ticket' | 'epic', version: number) => ({
  name, description: '', subject, bundled: false, version, inUse: { tickets: 0, workspaces: 0 }, assignedAs: [],
});
const library = [entry('Plain ticket', 'ticket', 2), entry('epic', 'epic', 1), entry('Migrated Epic (global)', 'epic', 1)];

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
    expect(optionTexts(host.querySelector('#settings-epic-workflow'))).toEqual(['Bundled default · epic · v1', 'epic · v1', 'Migrated Epic (global) · v1']);
    expect(host.textContent).toContain('Used when the Workspace has no Epic workflow of its own.');
  });

  it('workspace card names the bundled epic when no global is set', async () => {
    const host = await mountComponent(createElement(EpicWorkflowEditor, { surface: 'workspace', value: null, globalValue: null, onChange: () => {} }));
    expect(optionTexts(host.querySelector('#workspace-epic-workflow'))[0]).toBe('Use global default · epic');
  });

  it('workspace card inherits the global name and saves the choice', async () => {
    const onChange = vi.fn();
    const host = await mountComponent(createElement(EpicWorkflowEditor, { surface: 'workspace', value: null, globalValue: 'Migrated Epic (global)', onChange }));
    const select = host.querySelector<HTMLSelectElement>('#workspace-epic-workflow')!;
    expect(optionTexts(select)).toEqual(['Use global default · Migrated Epic (global)', 'epic · v1', 'Migrated Epic (global) · v1']);
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
  const wf = (chosen: 'workspace' | 'global') => ({ name: 'Migrated Epic (harmonic)', version: 1, chosen });
  const text = (host: Element) => host.textContent?.replace(/\s+/g, '');

  it.each([
    ['workspace', 'WorkflowMigratedEpic(harmonic)v1—WorkspaceEpicworkflow'],
    ['global', 'WorkflowMigratedEpic(harmonic)v1—globalEpicworkflow'],
  ] as const)('shows the %s source on one line', async (chosen, expected) => {
    const host = await mountComponent(createElement(EpicWorkflowLine, { workflow: wf(chosen) }));
    expect(text(host)).toBe(expected);
    expect(host.querySelector('.whitespace-nowrap')).not.toBeNull();
  });

  it('omits the line without a workflow', async () => {
    const host = await mountComponent(createElement(EpicWorkflowLine, { workflow: null }));
    expect(host.textContent).toBe('');
  });

  it('is not in the rail facts', async () => {
    const epic = { memberCount: 2, foldedCount: 1, baseBranch: 'develop', integration: { branch: 'epic/1' }, dependsOn: [], createdAt: 0, updatedAt: null, workflow: wf('global') } as unknown as Epic;
    const host = await mountComponent(createElement(EpicMeta, { epic, stats: null }));
    expect(host.textContent).not.toContain('Workflow');
  });
});
