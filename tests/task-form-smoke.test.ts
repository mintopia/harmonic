// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskForm } from '../web/src/components/TaskForm.js';
import type { Task, Workspace } from '../web/src/types.js';
import { cleanup, makeConfig, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderForm(props: { task: Task | null; workspace: Workspace | null; workspaceId: number | null; onSaved?: () => void }): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(props.task ?? {})));
  host = await mountComponent(
    createElement(TaskForm, {
      config: makeConfig({
        harnesses: { claude: { command: 'claude', args: [], env: {}, models: ['claude-sonnet-4-6', 'claude-opus-4-1'], defaultModel: 'claude-sonnet-4-6' } },
      }),
      task: props.task,
      workspace: props.workspace,
      workspaceId: props.workspaceId,
      onClose: () => {},
      onSaved: props.onSaved ?? (() => {}),
    }),
  );
  return host;
}

describe('TaskForm smoke (issue #469)', () => {
  it('renders the New task form with an empty prompt and the Create ready button', async () => {
    await renderForm({ task: null, workspace: makeWorkspace(), workspaceId: 1 });

    expect(host!.textContent).toContain('New task');
    const prompt = host!.querySelector<HTMLTextAreaElement>('#task-prompt');
    expect(prompt?.value).toBe('');
    const submit = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Create ready');
    expect(submit).toBeDefined();
    expect(submit?.disabled).toBe(true);
  });

  it('renders the Edit form pre-filled from the task and shows Save instead of Create', async () => {
    const task = makeTask({ id: 9, prompt: 'Edit me please', summary: 'Add retry backoff', state: 'draft' });

    await renderForm({ task, workspace: makeWorkspace(), workspaceId: null });

    expect(host!.textContent).toContain(`Edit Task ${task.id}`);
    const prompt = host!.querySelector<HTMLTextAreaElement>('#task-prompt');
    expect(prompt?.value).toBe('Edit me please');
    const buttons = [...host!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Save');
    expect(buttons).not.toContain('Create ready');
  });

  it('enables the submit button once a prompt is typed', async () => {
    await renderForm({ task: null, workspace: null, workspaceId: null });

    const prompt = host!.querySelector<HTMLTextAreaElement>('#task-prompt')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(prompt, 'A brand new task');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submit = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Create ready')!;
    expect(submit.disabled).toBe(false);
  });
});
