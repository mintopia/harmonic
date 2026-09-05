// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskCard } from '../web/src/components/Board.js';
import { cleanup, flush, makeTask, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderCard(state: 'working' | 'paused') {
  const task = makeTask({ state });
  host = await mountComponent(createElement(TaskCard, { task, onOpen: () => {} }));
  return task;
}

describe('Board pause controls', () => {
  it('pauses a working task from its card', async () => {
    const task = await renderCard('working');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(task)));
    vi.stubGlobal('fetch', fetchMock);

    const button = [...host!.querySelectorAll('button')].find((item) => item.textContent === 'Pause')!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}/pause`, { method: 'POST' });
  });

  it('shows paused state and resumes from its card', async () => {
    const task = await renderCard('paused');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(task)));
    vi.stubGlobal('fetch', fetchMock);

    expect(host!.textContent).toContain('paused');
    const button = [...host!.querySelectorAll('button')].find((item) => item.textContent === 'Resume')!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}/resume`, { method: 'POST' });
  });
});
