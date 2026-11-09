// @vitest-environment jsdom
import { act, createElement } from 'react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../web/src/api.js';
import { WorkflowsPage } from '../web/src/components/workflows/WorkflowsPage.js';
import type { WorkflowLibraryEntry } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const entry = (over: Partial<WorkflowLibraryEntry>): WorkflowLibraryEntry => ({
  name: 'docs-only',
  description: '',
  subject: 'ticket',
  version: 2,
  inUse: { tickets: 0, running: 0, workspaces: 0 },
  assignedAs: [],
  ...over,
});

const YAML = ['name: docs-only', 'description: d', 'steps:', '  - id: a', '    uses: rebase # retries: 1', '  - attempts:', '      max: 2', '      steps:', '        - id: b', '          uses: agent', ''].join('\n');

beforeEach(() => {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
  vi.spyOn(api, 'workflows').mockResolvedValue({
    total: 3,
    workflows: [
      entry({ name: 'Default', version: 5 }),
      entry({ name: 'security', inUse: { tickets: 2, running: 0, workspaces: 1 }, assignedAs: [{ kind: 'label', label: 'security' }] }),
      entry({ name: 'docs-only' }),
    ],
  });
  vi.spyOn(api, 'workflowTemplates').mockResolvedValue({
    total: 2,
    templates: [
      { name: 'implement', description: 'Implement a Ticket.', subject: 'ticket', text: '' },
      { name: 'epic', description: 'Run an Epic.', subject: 'epic', text: '' },
    ],
  });
  vi.spyOn(api, 'workflow').mockImplementation(async (name) => ({ name, description: '', version: 2, text: YAML }));
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const click = async (el: Element | null | undefined) => {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
};
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const editorView = (host: HTMLElement) => EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;

describe('Workflows page', () => {
  it('lists the library with disabled Delete and a why line when in use', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('Not assigned');
    expect(rows[1]!.textContent).toContain('In use by 2 Tickets and 1 Workspace and 1 Workflow Label.');
    expect(rows[1]!.textContent).toContain('Workflow Label · security');
    expect((button(rows[1] as HTMLElement, 'Delete') as HTMLButtonElement).disabled).toBe(true);
    expect((button(rows[2] as HTMLElement, 'Delete') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the empty state for a search with no match and clears it', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    const search = host.querySelector('input[type=search]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'lint');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    expect(host.textContent).toContain('No workflow matches “lint”');
    await click(button(host, 'Clear search'));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('lists templates apart from the library and creates a workflow from one, then opens it in the editor', async () => {
    const create = vi.spyOn(api, 'createWorkflowFromTemplate').mockImplementation(async () => {
      vi.spyOn(api, 'workflows').mockResolvedValue({ total: 4, workflows: [entry({ name: 'my-flow', version: 1 }), entry({ name: 'docs-only' }), entry({ name: 'Default' }), entry({ name: 'security' })] });
      return { name: 'my-flow', description: '', version: 1, text: YAML };
    });
    const host = await mountComponent(createElement(WorkflowsPage));
    const templates = host.querySelector('section[aria-labelledby=workflow-templates-title]') as HTMLElement;
    expect(templates.textContent).toContain('Implement a Ticket.');
    expect(templates.textContent).toContain('Epic template');
    expect(templates.querySelectorAll('table, [aria-label^="Open"]')).toHaveLength(0);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect([...templates.querySelectorAll('button')].some((b) => /delete|duplicate|export/i.test(b.textContent ?? ''))).toBe(false);
    await click(templates.querySelector('button[aria-label="New from template implement"]'));
    const input = document.body.querySelector('input[placeholder="docs-only"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' my-flow ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await click(button(document.body, 'Create workflow'));
    expect(create).toHaveBeenCalledWith('implement', 'my-flow');
    await act(async () => {
      await flush();
    });
    expect(host.textContent).toContain('my-flow');
    expect(host.querySelector('section[aria-labelledby=workflow-templates-title]')).toBeNull();
  });

  it('shows a refused template name in the dialog and stays on the library', async () => {
    vi.spyOn(api, 'createWorkflowFromTemplate').mockRejectedValue(new ApiError(409, 'A workflow named docs-only already exists'));
    const host = await mountComponent(createElement(WorkflowsPage));
    await click(host.querySelector('button[aria-label="New from template epic"]'));
    const input = document.body.querySelector('input[placeholder="docs-only"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'docs-only');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await click(button(document.body, 'Create workflow'));
    expect(document.body.querySelector('[role=alert]')?.textContent).toContain('already exists');
    expect(host.querySelector('section[aria-labelledby=workflow-templates-title]')).not.toBeNull();
  });

  it('confirms before deleting an unused workflow', async () => {
    const remove = vi.spyOn(api, 'deleteWorkflow').mockResolvedValue({});
    const host = await mountComponent(createElement(WorkflowsPage));
    await click(button(host.querySelectorAll('tbody tr')[2] as HTMLElement, 'Delete'));
    expect(remove).not.toHaveBeenCalled();
    await click(button(document.body, 'Delete workflow'));
    expect(remove).toHaveBeenCalledWith('docs-only');
  });

  it('puts a refused save at the issue line, keeps Save disabled, and re-enables it after an edit', async () => {
    vi.spyOn(api, 'saveWorkflow').mockRejectedValue(new ApiError(400, 'invalid', 'validation', null, [{ message: 'unknown key: retries', line: 5, column: 5 }]));
    const host = await mountComponent(createElement(WorkflowsPage));
    await click(host.querySelectorAll('tbody tr')[2]!.querySelector('td button'));
    const saveButton = () => button(host, 'Save')!;
    expect(saveButton().disabled).toBe(true);

    await act(async () => {
      [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'YAML')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });
    const view = editorView(host);
    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '# tweak\n' } });
      await flush();
    });
    expect(host.textContent).toContain('Edited');
    await click(button(host, 'Save as v3'));

    const flagged = host.querySelectorAll('.cm-issue-line');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.textContent).toContain('retries: 1');
    expect(flagged[0]!.getAttribute('data-issue-line')).toBe('5');
    expect(host.querySelector('.cm-issue-message')!.textContent).toBe('serverLine 5, col 5:unknown key: retries');
    expect(host.textContent).toContain('1 error');
    expect((button(host, 'Save · 1 error') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      view.dispatch({ changes: { from: 0, insert: '# x\n' } });
      await flush();
    });
    expect(host.querySelector('.cm-issue-line')).toBeNull();
    expect((button(host, 'Save as v3') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Workflow editor tabs', () => {
  it('shares one YAML across Blocks, YAML and Variables and keeps the diagram beside them', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    await click(host.querySelectorAll('tbody tr')[2]!.querySelector('td button'));
    const tab = (label: string) => [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith(label));
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Blocks', 'YAML', 'Variables · 0']);
    expect(host.querySelector('[aria-label="Workflow builder"]')).not.toBeNull();

    await click(tab('Variables'));
    const nameInput = host.querySelector('[aria-label="New variable name"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'fresh_var');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '+ Add variable'));
    expect(host.querySelector('[aria-label="Default for fresh_var"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Edited');

    await click(tab('YAML'));
    expect(editorView(host).state.doc.toString()).toContain('fresh_var');
    expect(host.querySelector('[aria-label="Workflow step diagram"]')).not.toBeNull();
    expect(host.textContent).toContain('Runs on');
    expect(host.textContent).toContain('until their next Retry');
    expect(host.textContent).toContain('Blocks and YAML in sync · 1 unsaved change');
    expect(host.textContent).toContain('Assigned as');
  });
});
