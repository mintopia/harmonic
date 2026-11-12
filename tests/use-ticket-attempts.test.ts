// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTicketAttempts } from '../web/src/components/useTicketAttempts.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

const { handlers, api } = vi.hoisted(() => ({
  handlers: [] as ((msg: unknown) => void)[],
  api: { taskAttemptTimeline: vi.fn(), taskAttempts: vi.fn() },
}));

vi.mock('../web/src/ws.js', () => ({ subscribe: (h: (msg: unknown) => void) => (handlers.push(h), () => undefined) }));
vi.mock('../web/src/api.js', () => ({ api }));
vi.mock('../web/src/toast.js', () => ({ toastError: vi.fn() }));

afterEach(() => {
  cleanup();
  handlers.length = 0;
  vi.clearAllMocks();
});

describe('useTicketAttempts', () => {
  it('picks up a starting Attempt from step_run_changed, since no attempt_changed fires at start', async () => {
    api.taskAttemptTimeline.mockResolvedValue({ attempts: [] });
    api.taskAttempts.mockResolvedValueOnce({ attempts: [] });
    let runs: { id: number }[] = [];
    await mountComponent(createElement(() => ((runs = useTicketAttempts(1).runs), null)));

    api.taskAttempts.mockResolvedValue({ attempts: [{ id: 9, taskId: 1, number: 1, state: 'running' }] });
    handlers.forEach((h) => h({ type: 'step_run_changed', taskId: 1, attemptId: 9 }));
    await flush();

    expect(runs.map((r) => r.id)).toEqual([9]);
  });
});
