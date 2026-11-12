// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTE } from '../web/src/router-model.js';
import { useAppSync } from '../web/src/useAppSync.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const { handlers, toastFail, toastSuccess } = vi.hoisted(() => ({ handlers: [] as ((msg: unknown) => void)[], toastFail: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('../web/src/ws.js', () => ({
  subscribe: (handler: (msg: unknown) => void) => {
    handlers.push(handler);
    return () => undefined;
  },
}));
vi.mock('../web/src/toast.js', () => ({ toastFail, toastError: vi.fn(), toastSuccess }));

afterEach(() => {
  cleanup();
  handlers.length = 0;
  toastFail.mockReset();
  toastSuccess.mockReset();
});

const pending = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as never;

async function pushExportFailed(over: Record<string, unknown>): Promise<void> {
  function Probe() {
    useAppSync({ authed: true, route: DEFAULT_ROUTE, navigate: () => undefined, apiImpl: pending, storage: { getItem: () => null, setItem: () => undefined } });
    return null;
  }
  await mountComponent(createElement(Probe));
  const msg = { type: 'export_failed', owner: { kind: 'task', taskId: 1 }, trackerRef: null, destination: 's3', disposition: 'done', error: 'AccessDenied', retry: 0, nextRetryAt: null, ...over };
  handlers.forEach((handler) => handler(msg));
}

describe('useAppSync export_failed toast', () => {
  it('names a Task by label with the pending retry time', async () => {
    const at = new Date(Date.now() + 5 * 60_000);
    await pushExportFailed({ owner: { kind: 'task', taskId: 412 }, nextRetryAt: at.toISOString() });

    const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    expect(toastFail).toHaveBeenCalledWith(`Export of Task 412 to S3 failed — retrying at ${clock}`);
  });

  it('names an Epic by its ref, never "#null"', async () => {
    await pushExportFailed({ owner: { kind: 'epic', epicRef: 42, workspaceId: 1 }, retry: 0 });

    expect(toastFail).toHaveBeenCalledWith('Export of Epic #42 to S3 failed — not retried');
  });

  it('says retries are exhausted after the last retry', async () => {
    await pushExportFailed({ owner: { kind: 'epic', epicRef: 42, workspaceId: 1 }, retry: 3 });

    expect(toastFail).toHaveBeenCalledWith('Export of Epic #42 to S3 failed — retries exhausted');
  });
});

describe('useAppSync merged toast', () => {
  const task = (over: Record<string, unknown>) => ({ id: 7, workspaceId: 1, state: 'working', mergeStatus: null, currentStep: null, ...over });
  async function push(...tasks: Record<string, unknown>[]): Promise<void> {
    function Probe() {
      useAppSync({ authed: true, route: { ...DEFAULT_ROUTE, scope: { kind: 'workspace' as const, workspaceId: 1 } }, navigate: () => undefined, apiImpl: pending, storage: { getItem: () => null, setItem: () => undefined } });
      return null;
    }
    await mountComponent(createElement(Probe));
    for (const t of tasks) await act(async () => handlers.forEach((handler) => handler({ type: 'task_changed', task: t })));
  }

  it('fires once a Task that ran a merge step reaches done', async () => {
    await push(task({ currentStep: { stepId: 'merge', action: 'merge', kind: 'publish' } }), task({ state: 'done' }));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a Task done without a merge step', async () => {
    await push(task({ currentStep: { stepId: 'implement', action: 'agent', kind: 'agent' } }), task({ state: 'done' }));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
