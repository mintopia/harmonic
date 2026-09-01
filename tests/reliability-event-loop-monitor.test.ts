import { describe, it, expect, vi } from 'vitest';
import { EventLoopMonitor, type StallInfo } from '../src/reliability/event-loop-monitor.js';

class FakeScheduler {
  clock = 0;
  private pending: (() => void) | null = null;
  now = (): number => this.clock;
  setTimer = (fn: () => void): unknown => {
    this.pending = fn;
    return {};
  };
  clearTimer = (): void => {
    this.pending = null;
  };
  fireAt(clock: number): void {
    this.clock = clock;
    const fn = this.pending;
    this.pending = null;
    fn?.();
  }
  get armed(): boolean {
    return this.pending !== null;
  }
}

function monitorWith(sched: FakeScheduler, opts: Partial<{ stallMs: number; reportThrottleMs: number; onStall: (i: StallInfo) => void }> = {}) {
  const stalls: StallInfo[] = [];
  const monitor = new EventLoopMonitor({
    probeMs: 1000,
    stallMs: opts.stallMs ?? 200,
    reportThrottleMs: opts.reportThrottleMs ?? 5000,
    onStall: opts.onStall ?? ((i) => stalls.push(i)),
    now: sched.now,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
  });
  return { monitor, stalls };
}

describe('EventLoopMonitor', () => {
  it('reports a stall when the probe fires past its due time', () => {
    const sched = new FakeScheduler();
    const { monitor, stalls } = monitorWith(sched);
    monitor.start();
    sched.fireAt(1300);
    expect(stalls).toEqual([{ lagMs: 300, delayMs: 1300 }]);
    expect(monitor.lastLagMs).toBe(300);
    expect(monitor.underPressure).toBe(true);
  });

  it('does not report and clears pressure when a probe fires on time', () => {
    const sched = new FakeScheduler();
    const { monitor, stalls } = monitorWith(sched);
    monitor.start();
    sched.fireAt(1300);
    sched.fireAt(2300);
    expect(stalls).toHaveLength(1);
    expect(monitor.lastLagMs).toBe(0);
    expect(monitor.underPressure).toBe(false);
  });

  it('re-arms after each probe so it keeps monitoring', () => {
    const sched = new FakeScheduler();
    const { monitor } = monitorWith(sched);
    monitor.start();
    expect(sched.armed).toBe(true);
    sched.fireAt(2000);
    expect(sched.armed).toBe(true);
  });

  it('throttles a sustained stall to one report per window, then reports again', () => {
    const sched = new FakeScheduler();
    const { monitor, stalls } = monitorWith(sched, { reportThrottleMs: 5000 });
    monitor.start();
    sched.fireAt(1300);
    sched.fireAt(2600);
    expect(stalls).toHaveLength(1);
    sched.fireAt(8000);
    expect(stalls).toHaveLength(2);
  });

  it('stops probing and cancels the pending probe', () => {
    const sched = new FakeScheduler();
    const { monitor, stalls } = monitorWith(sched);
    monitor.start();
    monitor.stop();
    expect(sched.armed).toBe(false);
    sched.fireAt(9999);
    expect(stalls).toHaveLength(0);
  });

  it('start is idempotent — a second call does not double-arm', () => {
    const sched = new FakeScheduler();
    const { monitor, stalls } = monitorWith(sched);
    monitor.start();
    monitor.start();
    sched.fireAt(1300);
    expect(stalls).toHaveLength(1);
  });

  it('defaults to the shared logger sink', () => {
    const sched = new FakeScheduler();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const monitor = new EventLoopMonitor({
      probeMs: 1000,
      stallMs: 200,
      now: sched.now,
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    monitor.start();
    sched.fireAt(1500);
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('event-loop');
    write.mockRestore();
  });
});
