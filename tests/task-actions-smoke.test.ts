// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskActions } from '../web/src/components/TaskActions.js';
import type { Task } from '../web/src/types.js';
import { cleanup, flush, makeTask, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

async function renderActions(props: { task: Task; variant: 'card' | 'footer'; onChanged?: () => void }): Promise<HTMLDivElement> {
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

  it('renders the footer escalation actions without Delete for an escalated task', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'escalated', hasCandidate: false });

    await renderActions({ task, variant: 'footer' });

    const buttons = [...host!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Reject with guidance…');
    expect(buttons).toContain('Close task');
    expect(buttons.some((b) => b?.includes('Accept'))).toBe(true);
    expect(buttons).not.toContain('Delete');
  });

  it('disables Accept when the escalated task has no candidate to merge', async () => {
    const task = makeTask({ id: 7, prompt: 'Add retry backoff', summary: 'Add retry backoff', state: 'escalated', hasCandidate: false });

    await renderActions({ task, variant: 'footer' });

    const accept = [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes('Accept'));
    expect(accept?.disabled).toBe(true);
    expect(accept?.title).toBe('Branch is empty — nothing to merge');
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
});
