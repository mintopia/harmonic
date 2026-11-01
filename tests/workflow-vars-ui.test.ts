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
    vi.spyOn(api, 'workflows').mockResolvedValue({ workflows: [{ name: 'wf', description: '', subject: 'ticket', bundled: false, version: 1, inUse: { tickets: 0, workspaces: 0 }, assignedAs: [] }], total: 1 });
    vi.spyOn(api, 'workflow').mockResolvedValue({ name: 'wf', description: '', bundled: false, version: 1, text: 'name: wf\ndescription: t\nvars:\n  maxAttempts: 3\nsteps:\n  - attempts:\n      max: ${{ vars.maxAttempts }}\n      steps:\n        - id: a\n          run: exit 1\n' });
  });

  it('Workspace card refuses a type mismatch inline and saves a valid number in the card', async () => {
    const onChange = vi.fn();
    const update = vi.spyOn(api, 'updateWorkspace').mockResolvedValue(makeWorkspace({}));
    const host = await mountComponent(createElement(WorkspaceWorkflowVars, { workspace: makeWorkspace({ workflowVars: null }), onChange }));
    await flush();
    expect(host.textContent).toContain('Workspace');
    expect(host.textContent).toContain('Settings › Running Tickets');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="maxAttempts"]')!;
    await typeInto(input, 'three');
    expect(host.textContent).toContain('maxAttempts must be a number (the workflow default is 3).');
    const saveButton = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save');
    expect(update).not.toHaveBeenCalled();
    await typeInto(input, '5');
    await act(async () => saveButton()!.click());
    expect(update).toHaveBeenCalledWith(expect.any(Number), { workflowVars: { wf: { maxAttempts: 5 } } });
    expect(onChange).toHaveBeenLastCalledWith({ wf: { maxAttempts: 5 } });
  });

  it('Ticket card shows the Workspace hint and saves the override', async () => {
    vi.spyOn(api, 'workflowVars').mockResolvedValue({
      workflowRef: 'wf@1',
      workflow: 'wf',
      vars: [{ name: 'maxAttempts', default: 3, workspace: 5, ticket: null, value: 5, source: 'workspace' }],
      snapshot: null,
    });
    const save = vi.spyOn(api, 'setWorkflowVars').mockResolvedValue({ workflowRef: 'wf@1', workflow: 'wf', vars: [], snapshot: null });
    const host = await mountComponent(createElement(TicketVariables, { taskId: 7 }));
    await flush();
    expect(host.textContent).toContain('3 ← Workspace 5');
    expect(host.textContent).toContain('Takes effect from the next Retry.');
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="maxAttempts"]')!, '2');
    const saveButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledWith(7, { maxAttempts: 2 });
  });
});
