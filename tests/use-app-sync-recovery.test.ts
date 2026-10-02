// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../web/src/api.js';
import { DEFAULT_ROUTE } from '../web/src/router-model.js';
import { useAppSync } from '../web/src/useAppSync.js';
import type { Epic } from '../web/src/epic-model.js';
import type { Task } from '../web/src/types.js';
import { cleanup, flush, makeTask, makeWorkspace, mountComponent } from './component-smoke-harness.js';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../web/src/toast.js', () => ({ toastError, toastFail: vi.fn(), toastSuccess: vi.fn() }));

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_reason: Error) => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const pending = () => new Promise<never>(() => undefined);
const storage = { getItem: () => null, setItem: () => undefined };
const navigate = () => undefined;
const epic = (ref: number): Epic => ({
  ref,
  title: `Epic ${ref}`,
  kind: 'spec',
  state: 'open',
  description: '',
  createdAt: 0,
  updatedAt: null,
  baseBranch: null,
  dependsOn: [],
  members: [],
  ready: [],
  integration: { branch: `epic/${ref}`, exists: false, tip: null },
  verification: { status: null, configured: false },
  integrate: { inFlight: false, held: null },
  mergeSteps: [],
  timelineEvents: [],
  foldedCount: 0,
  memberCount: 0,
  inPlace: false,
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
  toastError.mockReset();
});

describe('useAppSync recovery', () => {
  it('keeps the current workspace when an earlier workspace responds last', async () => {
    const taskA = deferred<{ tasks: Task[]; total: number }>();
    const taskB = deferred<{ tasks: Task[]; total: number }>();
    const epicA = deferred<{ epics: Epic[]; total: number }>();
    const epicB = deferred<{ epics: Epic[]; total: number }>();
    const epicsA = [epic(1)];
    const epicsB = [epic(2)];
    const apiImpl: typeof api = {
      ...api,
      config: pending,
      updateState: pending,
      globalPause: async () => ({ paused: false }),
      workspaces: async () => ({ workspaces: [makeWorkspace(), makeWorkspace({ id: 2 })], total: 2 }),
      tasks: ({ workspaceId, state } = {}) => state === 'open'
        ? (workspaceId === 1 ? taskA.promise : taskB.promise)
        : Promise.resolve({ tasks: [], total: 0 }),
      epics: (workspaceId) => workspaceId === 1 ? epicA.promise : epicB.promise,
    };
    let selectWorkspace = (_id: number) => {};
    let current: ReturnType<typeof useAppSync> | undefined;
    function Probe() {
      const [route, setRoute] = useState({ ...DEFAULT_ROUTE, scope: { kind: 'workspace' as const, workspaceId: 1 } });
      const sync = useAppSync({ authed: true, route, navigate, apiImpl, storage });
      useEffect(() => {
        selectWorkspace = (workspaceId) => setRoute({ ...route, scope: { kind: 'workspace', workspaceId } });
        current = sync;
      }, [route, sync]);
      return null;
    }
    await mountComponent(createElement(Probe));
    const staleRefresh = current?.refresh;
    await act(async () => { selectWorkspace(2); await flush(); });
    staleRefresh?.();
    await act(async () => {
      taskB.resolve({ tasks: [makeTask({ id: 2, workspaceId: 2 })], total: 1 });
      epicB.resolve({ epics: epicsB, total: 1 });
      await flush();
    });
    expect(current?.tasks?.map((task) => task.id)).toEqual([2]);
    expect(current?.epics.map((item) => item.ref)).toEqual([2]);
    await act(async () => {
      taskA.resolve({ tasks: [makeTask({ id: 1, workspaceId: 1 })], total: 1 });
      epicA.resolve({ epics: epicsA, total: 1 });
      await flush();
    });
    expect(current?.tasks?.map((task) => task.id)).toEqual([2]);
    expect(current?.epics.map((item) => item.ref)).toEqual([2]);
  });

  it('retries a failed first workspace load and keeps the error visible', async () => {
    const first = deferred<{ workspaces: ReturnType<typeof makeWorkspace>[]; total: number }>();
    const workspaces = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ workspaces: [makeWorkspace()], total: 1 });
    const apiImpl: typeof api = { ...api, config: pending, updateState: pending, globalPause: pending, workspaces };
    let current: ReturnType<typeof useAppSync> | undefined;
    function Probe() {
      const sync = useAppSync({ authed: true, route: DEFAULT_ROUTE, navigate, apiImpl, storage });
      useEffect(() => { current = sync; }, [sync]);
      return null;
    }
    await mountComponent(createElement(Probe));
    vi.useFakeTimers();
    await act(async () => { first.reject(new Error('temporary outage')); });
    expect(current?.workspacesLoaded).toBe(false);
    expect(current?.workspacesError).toBe('temporary outage');
    expect(toastError).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(current?.workspacesLoaded).toBe(true);
    expect(current?.workspaces.map((workspace) => workspace.id)).toEqual([1]);
    expect(current?.workspacesError).toBe(null);
    expect(workspaces).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('lets the operator retry workspace metadata immediately', async () => {
    const workspaces = vi.fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValue({ workspaces: [makeWorkspace()], total: 1 });
    const apiImpl: typeof api = { ...api, config: pending, updateState: pending, globalPause: pending, workspaces };
    let current: ReturnType<typeof useAppSync> | undefined;
    function Probe() {
      const sync = useAppSync({ authed: true, route: DEFAULT_ROUTE, navigate, apiImpl, storage });
      useEffect(() => { current = sync; }, [sync]);
      return null;
    }
    await mountComponent(createElement(Probe));
    expect(current?.workspacesError).toBe('temporary outage');
    await act(async () => { current?.retryWorkspaces(); await flush(); });
    expect(workspaces).toHaveBeenCalledTimes(2);
    expect(current?.workspacesError).toBe(null);
  });

  it('stops polling updates when the source distribution rejects them', async () => {
    const first = deferred<Awaited<ReturnType<typeof api.updateState>>>();
    const updateState = vi.fn().mockReturnValue(first.promise);
    const apiImpl: typeof api = { ...api, config: pending, updateState, globalPause: pending, workspaces: pending };
    function Probe() {
      useAppSync({ authed: true, route: DEFAULT_ROUTE, navigate, apiImpl, storage });
      return null;
    }
    await mountComponent(createElement(Probe));
    vi.useFakeTimers();
    await act(async () => { first.reject(new ApiError(409, 'in-place upgrades are only available for packaged instances', 'not_packaged')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(updateState).toHaveBeenCalledTimes(1);
  });

  it('retries transient update failures', async () => {
    const first = deferred<Awaited<ReturnType<typeof api.updateState>>>();
    const updateState = vi.fn().mockReturnValueOnce(first.promise).mockReturnValue(pending());
    const apiImpl: typeof api = { ...api, config: pending, updateState, globalPause: pending, workspaces: pending };
    function Probe() {
      useAppSync({ authed: true, route: DEFAULT_ROUTE, navigate, apiImpl, storage });
      return null;
    }
    await mountComponent(createElement(Probe));
    vi.useFakeTimers();
    await act(async () => { first.reject(new ApiError(503, 'temporary outage')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(updateState).toHaveBeenCalledTimes(2);
  });
});
