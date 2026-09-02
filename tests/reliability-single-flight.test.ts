import { describe, it, expect } from 'vitest';
import { singleFlight } from '../src/reliability/single-flight.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('runs the function once for a single call', async () => {
    let runs = 0;
    const invoke = singleFlight(async () => ++runs);
    expect(await invoke()).toBe(1);
    expect(runs).toBe(1);
  });

  it('runs again for a later, non-overlapping call', async () => {
    let runs = 0;
    const invoke = singleFlight(async () => ++runs);
    await invoke();
    await invoke();
    expect(runs).toBe(2);
  });

  it('coalesces calls that arrive while a run is in flight into exactly one rerun', async () => {
    let runs = 0;
    const gate = deferred<void>();
    const invoke = singleFlight(async () => {
      runs++;
      await gate.promise;
    });
    const first = invoke();
    const second = invoke();
    const third = invoke();
    expect(runs).toBe(1);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);
  });

  it('every caller in an in-flight window resolves with the final run result', async () => {
    let counter = 0;
    const gate = deferred<void>();
    const invoke = singleFlight(async () => {
      const n = ++counter;
      if (n === 1) await gate.promise;
      return n;
    });
    const first = invoke();
    const second = invoke();
    gate.resolve();
    expect(await first).toBe(2);
    expect(await second).toBe(2);
  });

  it('does not rerun when no call arrived during the run', async () => {
    let runs = 0;
    const invoke = singleFlight(async () => void runs++);
    await invoke();
    expect(runs).toBe(1);
  });

  it('propagates a rejection and recovers for the next call', async () => {
    let runs = 0;
    const invoke = singleFlight(async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
      return 'ok';
    });
    await expect(invoke()).rejects.toThrow('boom');
    expect(await invoke()).toBe('ok');
    expect(runs).toBe(2);
  });

  it('a call during a run that then throws still starts a fresh run afterwards', async () => {
    let runs = 0;
    const gate = deferred<void>();
    const invoke = singleFlight(async () => {
      runs++;
      if (runs === 1) {
        await gate.promise;
        throw new Error('first-failed');
      }
      return runs;
    });
    const first = invoke();
    const second = invoke();
    gate.resolve();
    await expect(first).rejects.toThrow('first-failed');
    await expect(second).rejects.toThrow('first-failed');
    expect(runs).toBe(1);
    expect(await invoke()).toBe(2);
  });
});
