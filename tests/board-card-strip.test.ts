// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Board, TaskCard } from '../web/src/components/Board.js';
import { cleanup, makeTask, mountComponent } from './component-smoke-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('Board card strip', () => {
  it('updates the remaining count as cards scroll and lets the operator advance', async () => {
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this instanceof HTMLElement && this.dataset.boardLayout === 'card-strip') return new DOMRect(0, 0, 500, 100);
      const strip = this.parentElement;
      if (strip instanceof HTMLElement && strip.dataset.boardLayout === 'card-strip') {
        const index = Array.from(strip.children).indexOf(this);
        return new DOMRect((index + 1) * 432 - 420 - strip.scrollLeft, 0, 420, 100);
      }
      return original.call(this);
    });

    const tasks = [1, 2, 3].map((id) => makeTask({ id, state: 'working' }));
    const host = await mountComponent(createElement(Board, {
      tasks,
      epics: [],
      loading: false,
      hasHistory: true,
      onOpen: () => {},
      onOpenTask: () => {},
      onNewTask: () => {},
    }));
    const strip = host.querySelector<HTMLElement>('[data-board-layout="card-strip"]')!;
    const cue = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Show "]');
    expect(cue()?.textContent).toContain('2 more');

    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy;
    await act(async () => { cue()!.click(); });
    expect(scrollBy).toHaveBeenCalledWith({ left: 432 });
    await act(async () => { strip.scrollLeft = 432; strip.dispatchEvent(new Event('scroll')); });
    expect(cue()?.textContent).toContain('1 more');
    await act(async () => { strip.scrollLeft = 864; strip.dispatchEvent(new Event('scroll')); });
    expect(cue()).toBeNull();
  });
});

describe('Board card escalation of a routed Task', () => {
  it('shows the escalation reason line and the routed label chip', async () => {
    const task = makeTask({
      state: 'escalated',
      escalationReason: 'escalated to human: Harness codex is not configured',
      routing: { label: 'reasoning', applied: true },
    });
    const host = await mountComponent(createElement(TaskCard, { task, onOpen: () => {} }));
    expect(host.textContent).toContain('Harness codex is not configured');
    expect(host.textContent).not.toContain('escalated to human:');
    expect(host.querySelector('code')?.textContent).toBe('reasoning');
    expect(host.textContent).toContain('↳');
  });
});
