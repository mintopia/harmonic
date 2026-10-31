// @vitest-environment jsdom
import { act, createElement } from 'react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { WorkflowsPage } from '../web/src/components/workflows/WorkflowsPage.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const good = ['name: w', 'description: d', 'steps:', '  - id: a', '    uses: rebase', '  - attempts:', '      max: 2', '      steps:', '        - id: b', '          uses: agent', ''].join('\n');

beforeEach(() => {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
  vi.spyOn(api, 'workflows').mockResolvedValue({
    total: 1,
    workflows: [{ name: 'w', description: '', bundled: false, version: 1, inUse: { tickets: 0, workspaces: 0 }, assignedAs: [] }],
  });
  vi.spyOn(api, 'workflow').mockResolvedValue({ name: 'w', description: '', bundled: false, version: 1, text: good });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;

describe('Workflow editor live validation', () => {
  it('flags an invalid key before save, disables Save, and keeps the diagram', async () => {
    const host = await mountComponent(createElement(WorkflowsPage));
    await act(async () => {
      (host.querySelector('tbody tr td button') as HTMLElement).click();
      await flush();
    });
    const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
    expect(host.querySelector('[data-testid="workflow-diagram"], [aria-label*="iagram"]')).not.toBeNull();
    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '          retries: 3\n' } });
      await flush();
    });
    expect(host.querySelector('.cm-issue-message')?.textContent).toContain('Line 11');
    expect(button(host, 'Save')!.disabled).toBe(true);
    expect(button(host, 'Save')!.textContent).toContain('1 error');
  });
});
