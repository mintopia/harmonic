// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTE } from '../web/src/router-model.js';
import { useAppSync } from '../web/src/useAppSync.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

const { handlers, toastFail } = vi.hoisted(() => ({ handlers: [] as ((msg: unknown) => void)[], toastFail: vi.fn() }));

vi.mock('../web/src/ws.js', () => ({
  subscribe: (handler: (msg: unknown) => void) => {
    handlers.push(handler);
    return () => undefined;
  },
}));
vi.mock('../web/src/toast.js', () => ({ toastFail, toastError: vi.fn(), toastSuccess: vi.fn() }));

afterEach(() => {
  cleanup();
  handlers.length = 0;
  toastFail.mockReset();
});

const pending = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as never;

async function pushExportFailed(over: Record<string, unknown>): Promise<void> {
  function Probe() {
    useAppSync({ authed: true, route: DEFAULT_ROUTE, navigate: () => undefined, apiImpl: pending, storage: { getItem: () => null, setItem: () => undefined } });
    return null;
  }
  await mountComponent(createElement(Probe));
  const msg = { type: 'export_failed', taskId: null, epicRef: null, workspaceId: 1, trackerRef: null, destination: 's3', disposition: 'done', error: 'AccessDenied', retry: 0, nextRetryAt: null, ...over };
  handlers.forEach((handler) => handler(msg));
}

describe('useAppSync export_failed toast', () => {
  it('names a Task by label with the pending retry time', async () => {
    await pushExportFailed({ taskId: 412, nextRetryAt: new Date(Date.now() + 5 * 60_000).toISOString() });

    expect(toastFail).toHaveBeenCalledWith('Export of Task 412 to s3 failed — retrying in 5 min');
  });

  it('names an Epic by its ref when taskId is null, never "#null"', async () => {
    await pushExportFailed({ epicRef: 42, retry: 0 });

    expect(toastFail).toHaveBeenCalledWith('Export of Epic #42 to s3 failed — not retried');
  });

  it('says retries are exhausted after the last retry', async () => {
    await pushExportFailed({ epicRef: 42, retry: 3 });

    expect(toastFail).toHaveBeenCalledWith('Export of Epic #42 to s3 failed — retries exhausted');
  });
});
