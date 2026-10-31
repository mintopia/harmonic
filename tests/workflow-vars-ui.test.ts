// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/api.js';
import { TicketVariables, WorkspaceWorkflowVars } from '../web/src/components/WorkflowVarsEditors.js';
import { cleanup, flush, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('workflow variables UI', () => {
  beforeEach(() => {
    vi.spyOn(api, 'workflows').mockResolvedValue({ workflows: [{ name: 'wf', description: '', bundled: false, version: 1 }], total: 1 });
    vi.spyOn(api, 'workflow').mockResolvedValue({ name: 'wf', description: '', bundled: false, version: 1, text: 'name: wf\ndescription: t\nvars:\n  maxattempts: 3\nsteps:\n  - attempts:\n      max: ${{ vars.maxattempts }}\n      steps:\n        - id: a\n          run: exit 1\n' });
  });

  it('Workspace card refuses a type mismatch inline and commits a valid number', async () => {
    const onChange = vi.fn();
    const host = await mountComponent(createElement(WorkspaceWorkflowVars, { workspace: makeWorkspace({ workflowVars: null }), onChange }));
    await flush();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="maxattempts"]')!;
    await typeInto(input, 'three');
    expect(host.textContent).toContain('maxattempts must be a number (the workflow default is 3).');
    expect(onChange).not.toHaveBeenCalled();
    await typeInto(input, '5');
    expect(onChange).toHaveBeenLastCalledWith({ wf: { maxattempts: 5 } });
  });

  it('Ticket card shows the Workspace hint and saves the override', async () => {
    vi.spyOn(api, 'workflowVars').mockResolvedValue({
      workflowRef: 'wf@1',
      workflow: 'wf',
      vars: [{ name: 'maxattempts', default: 3, workspace: 5, ticket: null, value: 5, source: 'workspace' }],
      snapshot: null,
    });
    const save = vi.spyOn(api, 'setWorkflowVars').mockResolvedValue({ workflowRef: 'wf@1', workflow: 'wf', vars: [], snapshot: null });
    const host = await mountComponent(createElement(TicketVariables, { taskId: 7 }));
    await flush();
    expect(host.textContent).toContain('3 ← Workspace 5');
    expect(host.textContent).toContain('Takes effect from the next Retry.');
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="maxattempts"]')!, '2');
    const saveButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledWith(7, { maxattempts: 2 });
  });
});
