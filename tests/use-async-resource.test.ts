// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAsyncResource, type AsyncResource } from '../web/src/useAsyncResource.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: ReturnType<typeof createElement>): Promise<void> {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  return act(async () => {
    root?.render(node);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Snapshot<T> = { data: T | null; error: string | null; loading: boolean };

function snapshotOf<T>(r: AsyncResource<T>): Snapshot<T> {
  return { data: r.data, error: r.error, loading: r.loading };
}

describe('useAsyncResource', () => {
  it('loading -> error -> retry -> success', async () => {
    const renders: Snapshot<{ ok: number }>[] = [];
    let reload: () => void = () => {};

    const first = deferred<{ ok: number }>();
    const second = deferred<{ ok: number }>();
    const load = vi
      .fn<() => Promise<{ ok: number }>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    function Probe() {
      const resource = useAsyncResource(load, []);
      useEffect(() => {
        reload = resource.reload;
      });
      renders.push(snapshotOf(resource));
      return null;
    }

    await mount(createElement(Probe));
    expect(renders[0]).toEqual({ data: null, error: null, loading: true });

    await act(async () => {
      first.reject(new Error('boom'));
      await first.promise.catch(() => {});
    });
    expect(renders[renders.length - 1]).toEqual({ data: null, error: 'boom', loading: false });

    await act(async () => {
      reload();
    });
    expect(renders[renders.length - 1]).toEqual({ data: null, error: 'boom', loading: true });

    await act(async () => {
      second.resolve({ ok: 1 });
      await second.promise;
    });

    expect(renders[renders.length - 1]).toEqual({ data: { ok: 1 }, error: null, loading: false });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rapid retry clicks do not stack requests', async () => {
    const load = vi.fn<() => Promise<string>>();
    const first = deferred<string>();
    load.mockImplementationOnce(() => first.promise);

    let reload: () => void = () => {};
    function Probe() {
      const resource = useAsyncResource(load, []);
      useEffect(() => {
        reload = resource.reload;
      });
      return null;
    }

    await mount(createElement(Probe));
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      reload();
      reload();
      reload();
    });
    expect(load).toHaveBeenCalledTimes(1);

    const second = deferred<string>();
    load.mockImplementationOnce(() => second.promise);

    await act(async () => {
      first.resolve('a');
      await first.promise;
    });

    await act(async () => {
      reload();
    });
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve('b');
      await second.promise;
    });
  });

  it('a deps change resets state and gates out the stale in-flight request', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn((key: number) => (key === 1 ? first.promise : second.promise));

    const renders: Snapshot<string>[] = [];
    let setKey: (k: number) => void = () => {};

    function Probe() {
      const [key, keySetter] = useState(1);
      const resource = useAsyncResource(() => load(key), [key]);
      useEffect(() => {
        setKey = keySetter;
      }, [keySetter]);
      renders.push(snapshotOf(resource));
      return null;
    }

    await mount(createElement(Probe));
    expect(load).toHaveBeenCalledWith(1);

    await act(async () => {
      setKey(2);
    });
    expect(load).toHaveBeenCalledWith(2);

    await act(async () => {
      first.resolve('stale');
      await first.promise;
    });
    expect(renders.some((r) => r.data === 'stale')).toBe(false);

    await act(async () => {
      second.resolve('fresh');
      await second.promise;
    });
    expect(renders[renders.length - 1]).toEqual({ data: 'fresh', error: null, loading: false });
  });

  it('load === null is idle: no request, no-op reload', async () => {
    let calls = 0;
    let reload: () => void = () => {};
    const renders: Snapshot<string>[] = [];

    function Probe() {
      const resource = useAsyncResource<string>(null, []);
      useEffect(() => {
        reload = resource.reload;
      });
      renders.push(snapshotOf(resource));
      return null;
    }

    await mount(createElement(Probe));
    expect(renders.every((r) => r.loading === false && r.data === null && r.error === null)).toBe(true);

    await act(async () => {
      reload();
      calls++;
    });
    expect(calls).toBe(1);
    expect(renders[renders.length - 1]).toEqual({ data: null, error: null, loading: false });
  });

  it('a failed poll keeps the last-good data on screen', async () => {
    let call = 0;
    const load = vi.fn(() => {
      call++;
      return call === 1 ? Promise.resolve('a') : Promise.reject(new Error('poll failed'));
    });

    const latestResource: { current: AsyncResource<string> | null } = { current: null };
    function Probe() {
      const resource = useAsyncResource(load, [], { pollMs: 15 });
      useEffect(() => {
        latestResource.current = resource;
      });
      return null;
    }

    await mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestResource.current?.data).toBe('a');

    let latest: Snapshot<string> = { data: null, error: null, loading: false };
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        await wait(10);
      });
      latest = snapshotOf(latestResource.current!);
      if (latest.error !== null) break;
    }

    expect(latest).toEqual({ data: 'a', error: 'poll failed', loading: false });
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
