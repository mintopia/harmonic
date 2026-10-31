// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { WorkflowEditor } from '../web/src/components/WorkflowEditor.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const good = ['name: w', 'description: d', 'steps:', '  - id: a', '    uses: rebase', '  - attempts:', '      max: 2', '      steps:', '        - id: b', '          uses: agent', ''].join('\n');
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const props = { name: 'w', version: 1, bundled: false, initialText: good, onSave: async () => {}, onExport: () => {}, onDuplicate: () => {} };

describe('WorkflowEditor', () => {
  it('marks an invalid key before save and disables Save', async () => {
    const container = await mountComponent(createElement(WorkflowEditor, props));
    await wait(400);
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Save'))!;
    expect(container.querySelector('[data-testid="workflow-error"]')).toBeNull();
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '          retries: 3\n' } }); });
    await wait(400);
    expect(container.querySelector('[data-testid="workflow-error"]')?.textContent).toContain('Line 11, col 11');
    expect(container.querySelector('.cm-lintRange-error')).not.toBeNull();
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain('1 error');
  });

  it('is read-only when bundled', async () => {
    const container = await mountComponent(createElement(WorkflowEditor, { ...props, bundled: true }));
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Save'))).toBe(false);
  });
});
