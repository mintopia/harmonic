// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TicketPage } from '../web/src/components/TicketPage.js';
import type { Task } from '../web/src/types.js';
import { cleanup, flush, makeConfig, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const REASON = "Routing Label 'bulk' needs Harness 'opencode', which is not configured.";
const calls: { method: string; path: string; body: unknown }[] = [];

async function render(reason: string): Promise<HTMLDivElement> {
  const task: Task = makeTask({ state: 'escalated', escalationReason: reason });
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
  it('shows the actions only for a not-configured reason', async () => {
    const host = await render(REASON);
    expect(button(host, 'Set Harness on this Ticket')).toBeDefined();
    expect(button(host, 'Retry')).toBeDefined();
  });

  it('hides the actions for any other reason', async () => {
    const host = await render('verification failed');
    expect(host.textContent).toContain('verification failed');
    expect(button(host, 'Retry')).toBeUndefined();
  });

  it('the dialog PATCHes the chosen harness', async () => {
    const host = await render(REASON);
    await act(async () => button(host, 'Set Harness on this Ticket')!.click());
    await flush();
    await act(async () => button(document.body as HTMLElement, 'Save')!.click());
    await flush();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ harness: 'claude' });
  });
  it('Retry rejects the task with empty guidance', async () => {
    const host = await render(REASON);
    await act(async () => button(host, 'Retry')!.click());
    await flush();
    expect(calls.find((c) => c.path.endsWith('/reject'))?.body).toMatchObject({ guidance: '' });
  });

});
