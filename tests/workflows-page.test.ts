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
  bundled: false,
  version: 2,
  inUse: { tickets: 0, workspaces: 0 },
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
      entry({ name: 'Default', bundled: true, version: 5 }),
      entry({ name: 'security', inUse: { tickets: 2, workspaces: 1 }, assignedAs: [{ kind: 'label', label: 'security' }] }),
      entry({ name: 'docs-only' }),
    ],
  });
  vi.spyOn(api, 'workflow').mockImplementation(async (name) => ({ name, description: '', bundled: name === 'Default', version: 2, text: YAML }));
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
  it('lists the library with disabled Delete and a why line when bundled or in use', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('Bundled workflows are read-only.');
    expect(rows[0]!.textContent).toContain('the process Harmonic runs today');
    expect(rows[1]!.textContent).toContain('In use by 2 Tickets and 1 Workspace and 1 Workflow Label.');
    expect(rows[1]!.textContent).toContain('Workflow Label · security');
    expect((button(rows[0] as HTMLElement, 'Delete') as HTMLButtonElement).disabled).toBe(true);
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

  it('opens a bundled workflow read-only with a banner and no editing', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    await click(host.querySelectorAll('tbody tr')[0]!.querySelector('td button'));
    expect(host.textContent).toContain('Read-only.');
    expect(host.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false');
    expect((button(host, 'Save') as HTMLButtonElement).disabled).toBe(true);
    expect((button(host, 'Delete') as HTMLButtonElement).disabled).toBe(true);
  });
});
