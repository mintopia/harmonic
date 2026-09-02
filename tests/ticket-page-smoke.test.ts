// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TicketPage } from '../web/src/components/TicketPage.js';
import type { Task, Workspace } from '../web/src/types.js';
import { cleanup, makeConfig, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

function stubTicketFetch(task: Task, workspace: Workspace) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path === '/api/config') return new Response(JSON.stringify(makeConfig()));
    if (path === '/api/workspaces') return new Response(JSON.stringify({ workspaces: [workspace], total: 1 }));
    if (path === '/api/tasks') return new Response(JSON.stringify({ tasks: [task], total: 1 }));
    if (path === `/api/tasks/${task.id}`) return new Response(JSON.stringify(task));
    if (path === `/api/tasks/${task.id}/timeline`) return new Response(JSON.stringify({ events: [], total: 0 }));
    if (path === `/api/tasks/${task.id}/attempts/timeline`) return new Response(JSON.stringify({ attempts: [], budgetBase: 0, total: 0 }));
    if (path === `/api/tasks/${task.id}/attempts`) return new Response(JSON.stringify({ attempts: [], total: 0 }));
    return new Response(JSON.stringify({}));
  });
}

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderTicket(task: Task, selection: { kind: 'none' } | { kind: 'attempt'; attemptNumber: number } = { kind: 'none' }): Promise<HTMLDivElement> {
  const workspace = makeWorkspace({ id: task.workspaceId });
  stubTicketFetch(task, workspace);
  host = await mountComponent(
    createElement(TicketPage, {
      task,
      onEdit: () => {},
      onChanged: () => {},
      onClose: () => {},
      onOpenTask: () => {},
      selection,
      onSelect: () => {},
    }),
  );
  return host;
}

describe('TicketPage smoke (issue #469)', () => {
  it('renders the ticket header, progress bar and empty stats panel with no attempts', async () => {
    const task = makeTask();

    await renderTicket(task);

    expect(host!.textContent).toContain('Fix the flaky retry test');
    expect(host!.querySelector('ol[aria-label="Task progress"]')).not.toBeNull();
    expect(host!.querySelector('section[aria-label="Attempt history"]')?.textContent).toContain("hasn't been attempted yet");
    expect(host!.textContent).toContain("The Task's AI-usage breakdown will appear here once an Attempt has run.");
  });

  it('shows the No attempts yet empty state when an attempt is selected but none exist', async () => {
    const task = makeTask({ id: 43 });

    await renderTicket(task, { kind: 'attempt', attemptNumber: 1 });

    expect(host!.textContent).toContain('No attempts yet');
    expect(host!.textContent).toContain("This task hasn't run yet.");
  });

  it('shows the escalated banner for an escalated task', async () => {
    const task = makeTask({ id: 44, state: 'escalated', escalationReason: 'escalated to human: repeated verification failures' });

    await renderTicket(task);

    expect(host!.textContent).toContain('Escalated');
    expect(host!.textContent).toContain('repeated verification failures');
    expect(host!.textContent).toContain('Accept');
    expect(host!.textContent).toContain('Reject');
  });
});
