// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskActions } from '../web/src/components/TaskActions.js';
import type { Task } from '../web/src/types.js';
import { Toaster } from '../web/src/toast.js';
import { cleanup, flush, makeTask, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderActions(props: { task: Task; variant: 'card' | 'footer' | 'bar'; onChanged?: () => void }): Promise<HTMLDivElement> {
  host = await mountComponent(
    createElement(TaskActions, {
      task: props.task,
      variant: props.variant,
      onEdit: () => {},
      onChanged: props.onChanged ?? (() => {}),
    }),
  );
  return host;
}

describe('TaskActions smoke (issue #469)', () => {
  it('renders the card actions for a ready task', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'ready' });

    await renderActions({ task, variant: 'card' });

    const buttons = [...host!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Run now');
    expect(buttons).toContain('Edit');
    expect(buttons).toContain('Cancel');
    expect(buttons).toContain('Delete');
  });

  it('renders the escalated action bar without Delete for an escalated task', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'escalated', hasCandidate: false });

    await renderActions({ task, variant: 'bar' });

    const buttons = [...host!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Retry…');
    expect(buttons).not.toContain('Requeue');
    expect(buttons).toContain('Close task');
    expect(buttons.some((b) => b?.includes('Accept'))).toBe(true);
    expect(buttons).not.toContain('Delete');
    expect(buttons.map((b) => b?.replace(/ .*/, '').replace('…', ''))).toEqual(['Close', 'Retry', 'Accept']);
    const bar = host!.firstElementChild!;
    expect(bar.className).toContain('border-t');
    expect(bar.lastElementChild!.className).toContain('ml-auto');
    expect([...bar.lastElementChild!.querySelectorAll('button')].map((b) => b.textContent?.replace(/ .*/, ''))).toEqual(['Retry…', 'Accept']);
  });

  it('disables Accept when the escalated task has no candidate to merge', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'escalated', hasCandidate: false });

    await renderActions({ task, variant: 'bar' });

    const accept = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes('Accept'));
    expect(accept?.disabled).toBe(true);
    expect(accept?.title).toBe('No candidate commits to accept');
  });

  it('disables the escalation actions while an Accept is merging', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'escalated', hasCandidate: true, mergeStatus: 'merging' });

    await renderActions({ task, variant: 'bar' });

    const buttons = [...host!.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled).toBe(true);
    expect(buttons.some((b) => b.textContent === 'Accepting…')).toBe(true);
  });

  it('calls the run API and onChanged when Run now is clicked', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'ready' });
    let changed = false;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(task)));

    await renderActions({ task, variant: 'card', onChanged: () => { changed = true; } });

    const run = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Run now')!;
    await act(async () => {
      run.click();
      await flush();
    });

    expect(changed).toBe(true);
  });

  it('pauses a working task through the pause endpoint', async () => {
    const task = makeTask({ id: 7, state: 'working' });
    const changed = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(task)));
    vi.stubGlobal('fetch', fetchMock);

    await renderActions({ task, variant: 'footer', onChanged: changed });

    const button = [...host!.querySelectorAll('button')].find((item) => item.textContent === 'Pause')!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}/pause`, { method: 'POST' });
    expect(changed).toHaveBeenCalledOnce();
  });

  it('resumes a paused task through the resume dialog', async () => {
    const task = makeTask({ id: 7, state: 'paused' });
    const changed = vi.fn();
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes('/continuation') ? { available: false } : task)),
    );
    vi.stubGlobal('fetch', fetchMock);

    await renderActions({ task, variant: 'footer', onChanged: changed });

    const open = [...host!.querySelectorAll('button')].find((item) => item.textContent === 'Resume')!;
    await act(async () => {
      open.click();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}/continuation`, { method: 'GET' });

    const dialog = host!.querySelector('dialog')!;
    const confirm = [...dialog.querySelectorAll('button')].find((item) => item.textContent === 'Resume')!;
    await act(async () => {
      confirm.click();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}/resume`, { method: 'POST' });
    expect(changed).toHaveBeenCalledOnce();
  });
});

describe('Accept feedback', () => {
  it('explains the overridden step and reports the actual server response', async () => {
    const task = makeTask({ state: 'escalated', hasCandidate: true });
    const updated = makeTask({ state: 'working', currentStep: 'review' });
    const fetch = vi.fn(async () => new Response(JSON.stringify(updated)));
    vi.stubGlobal('fetch', fetch);
    const onChanged = vi.fn();
    const host = await mountComponent(createElement(Fragment, null,
      createElement(TaskActions, { task, failedStep: 'verification', variant: 'bar', onEdit: () => {}, onChanged }),
      createElement(Toaster),
    ));
    expect(host.textContent).not.toContain('Override the failed verification step');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept & review')?.title).toBe('Override the failed verification step and continue with review.');
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Accept & review')!.click();
      await flush();
    });
    expect(fetch).toHaveBeenCalledWith(`/api/tasks/${task.id}/accept`, { method: 'POST' });
    const accepted = [...host.querySelectorAll('[role="status"]')].find((notice) => notice.textContent?.includes('Task 42 accepted'));
    expect(accepted?.textContent).toContain('accepted — continuing with review');
    expect(accepted?.textContent).not.toContain('merging');
    expect(onChanged).toHaveBeenCalledOnce();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss"]').forEach((button) => button.click()));
  });
});
