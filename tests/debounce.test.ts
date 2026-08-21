import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../web/src/debounce.js';

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst into a single trailing call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 250);
    d();
    d();
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires with the arguments of the last call in the burst', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('first');
    d('second');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('second');
  });

  it('restarts the window on each call, so a steady stream never fires', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    for (let i = 0; i < 10; i++) {
      d();
      vi.advanceTimersByTime(90);
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('separates bursts spaced beyond the delay into distinct calls', () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d();
    vi.advanceTimersByTime(50);
    d();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel() drops a pending trailing call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d();
    d.cancel();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
  });
});
