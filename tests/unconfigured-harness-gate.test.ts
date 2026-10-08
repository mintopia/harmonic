// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TicketPage } from '../web/src/components/TicketPage.js';
import type { Task } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const REASON = "Routing Label 'bulk' needs Harness 'opencode', which is not configured.";
const calls: { method: string; path: string; body: unknown }[] = [];

const CAUSE = { kind: 'harness_unconfigured', harness: 'opencode', label: 'bulk' } as const;

async function render(reason: string, escalationCause: Task['escalationCause'] = null): Promise<HTMLDivElement> {
  const task: Task = makeTask({ state: 'escalated', escalationReason: reason, escalationCause });
  const workspace = makeWorkspace({ id: task.workspaceId });
  calls.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === '/api/config') return new Response(JSON.stringify(makeConfig()));
    if (path === '/api/workspaces') return new Response(JSON.stringify({ workspaces: [workspace], total: 1 }));
    if (path === '/api/tasks') return new Response(JSON.stringify({ tasks: [task], total: 1 }));
    if (path === `/api/tasks/${task.id}/attempts/timeline`) return new Response(JSON.stringify({ attempts: [], budgetBase: 0, total: 0 }));
    if (path === `/api/tasks/${task.id}/attempts`) return new Response(JSON.stringify({ attempts: [], total: 0 }));
    if (path === `/api/tasks/${task.id}/timeline`) return new Response(JSON.stringify({ events: [], total: 0 }));
    return new Response(JSON.stringify(task));
  });
  return mountComponent(
    createElement(TicketPage, {
      task,
      onEdit: () => {},
      onChanged: () => {},
      onClose: () => {},
      onOpenTask: () => {},
      selection: { kind: 'none' },
      onSelect: () => {},
    }),
  );
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('unconfigured Harness escalation gate', () => {
  it('shows the actions only for a structured not-configured cause', async () => {
    const host = await render(REASON, CAUSE);
    expect(button(host, 'Set Harness on this Ticket')).toBeDefined();
    expect(button(host, 'Retry')).toBeDefined();
    expect(button(host, 'Close')).toBeDefined();
    expect(host.textContent).toContain(
      "Routing Label bulk routes to Harness opencode, which is not configured. No Attempt was started. Configure the Harness in Global settings › Integrations › Harnesses, change the label's route in Settings › Execution › Routing Labels, or set a Harness on this Ticket.",
    );
  });

  it('ignores a reason that only reads like the harness message', async () => {
    const host = await render(REASON);
    expect(button(host, 'Retry')).toBeUndefined();
  });

  it('hides the actions for any other reason', async () => {
    const host = await render('verification failed');
    expect(host.textContent).toContain('verification failed');
    expect(button(host, 'Retry')).toBeUndefined();
  });

  it('the dialog PATCHes the chosen harness', async () => {
    const host = await render(REASON, CAUSE);
    await act(async () => button(host, 'Set Harness on this Ticket')!.click());
    await flush();
    await act(async () => button(document.body as HTMLElement, 'Save')!.click());
    await flush();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ harness: 'claude' });
  });
  it('Retry rejects the task with descriptive guidance', async () => {
    const host = await render(REASON, CAUSE);
    await act(async () => button(host, 'Retry')!.click());
    await flush();
    expect(calls.find((c) => c.path.endsWith('/reject'))?.body).toMatchObject({ guidance: 'Retry after changing the route.' });
  });

});
