// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskForm } from '../web/src/components/TaskForm.js';
import type { Task, Workspace } from '../web/src/types.js';
import { cleanup, makeConfig, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderForm(props: { task: Task | null; workspace: Workspace | null; workspaceId: number | null; onSaved?: () => void; onClose?: () => void }): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(props.task ?? {})));
  host = await mountComponent(
    createElement(TaskForm, {
      config: makeConfig({
        harnesses: { claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-1' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 } },
      }),
      task: props.task,
      workspace: props.workspace,
      workspaceId: props.workspaceId,
      onClose: props.onClose ?? (() => {}),
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

  it('confirms before discarding a typed task and keeps it after cancel', async () => {
    const onClose = vi.fn();
    await renderForm({ task: null, workspace: null, workspaceId: null, onClose });
    const prompt = host!.querySelector<HTMLTextAreaElement>('#task-prompt')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(prompt, 'Keep this task');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    expect(host!.textContent).toContain('Discard unsaved changes?');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click(); });
    expect(prompt.value).toBe('Keep this task');

    await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    await act(async () => { [...host!.querySelectorAll('button')].find((button) => button.textContent === 'Discard')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables Save and shows a load error when lazily hydrating the prompt fails (issue #654)', async () => {
    const task = makeTask({ id: 11, prompt: undefined, summary: 'Investigate memory leak', state: 'ready' });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'network unreachable' } }), { status: 500 }));

    host = await mountComponent(
      createElement(TaskForm, {
        config: makeConfig({
          harnesses: { claude: { command: 'claude', args: [], env: {}, models: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-1' }], defaultModel: 'claude-sonnet-4-6', cacheWarmSeconds: 300 } },
        }),
        task,
        workspace: makeWorkspace(),
        workspaceId: null,
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(host!.querySelector('[role="alert"]')?.textContent).toContain('network unreachable');
    const prompt = host!.querySelector<HTMLTextAreaElement>('#task-prompt');
    expect(prompt?.disabled).toBe(true);
    expect(prompt?.value).toBe('');
    const submit = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    expect(submit?.disabled).toBe(true);
  });

  it('labels the mirrored Issue Workflow on the Edit form', async () => {
    const task = makeTask({ id: 10, state: 'draft', issueWorkflow: 'implement' });

    await renderForm({ task, workspace: makeWorkspace(), workspaceId: null });

    expect(host!.textContent).toContain('Issue Workflow');
    expect(host!.textContent).toContain('implement');
  });
  it('offers the workflow library in a Task Execution Workflow select and sends the choice', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(makeTask()));
      }
      if (url.endsWith('/api/workflows')) {
        return new Response(JSON.stringify({ workflows: [{ name: 'implement', description: 'd', version: 1 }], total: 1 }));
      }
      return new Response('{}');
    });
    const onSaved = vi.fn();
    host = await mountComponent(
      createElement(TaskForm, { config: makeConfig(), task: null, workspace: null, workspaceId: 1, onClose: () => {}, onSaved }),
    );

    const select = host.querySelector<HTMLSelectElement>('#task-execution-workflow')!;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(["None — today's behaviour", 'implement']);

    const setPrompt = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const prompt = host.querySelector<HTMLTextAreaElement>('#task-prompt')!;
    await act(async () => {
      setPrompt.call(prompt, 'Do it');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'implement');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Create ready')!.click(); });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ prompt: 'Do it', workflow: 'implement' });
  });

  it('omits workflow from the request when none is chosen', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ workflows: [], total: 0 }));
    });
    host = await mountComponent(
      createElement(TaskForm, { config: makeConfig(), task: null, workspace: null, workspaceId: 1, onClose: () => {}, onSaved: () => {} }),
    );
    const setPrompt = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const prompt = host.querySelector<HTMLTextAreaElement>('#task-prompt')!;
    await act(async () => {
      setPrompt.call(prompt, 'Plain');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Create ready')!.click(); });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('workflow');
  });

  it('hides the workflow select when editing an existing task', async () => {
    await renderForm({ task: makeTask({ id: 12, state: 'draft' }), workspace: makeWorkspace(), workspaceId: null });
    expect(host!.querySelector('#task-execution-workflow')).toBeNull();
  });
});
