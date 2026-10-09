import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/server/bus.js';
import { registerBusListeners } from '../src/server/app-bus-listeners.js';

function setup() {
  const bus = new EventBus();
  const publishWorktrees = vi.fn(async () => {});
  registerBusListeners(bus, {
    autoRunner: { poke: vi.fn() },
    upgrade: { reconcile: vi.fn(async () => {}) },
    publishWorktrees,
    drainRetirement: vi.fn(async () => 0),
    tasks: { list: vi.fn(async () => []) },
    attempts: { countRunning: vi.fn(async () => 0) },
    notifier: { notify: vi.fn(async () => {}) },
    fireAndForget: (fn: () => Promise<unknown>) => { void fn(); },
  } as never);
  return { bus, publishWorktrees };
}

describe('worktree publish throttle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('measures at most once per 30s window for a burst of task events', async () => {
    const { bus, publishWorktrees } = setup();
    for (let i = 0; i < 50; i++) bus.emit('task_changed', {} as never);
    bus.emit('task_removed', 1 as never);
    expect(publishWorktrees).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(publishWorktrees).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publishWorktrees).toHaveBeenCalledTimes(1);
  });

  it('schedules a new window for events after the timer fires', async () => {
    const { bus, publishWorktrees } = setup();
    bus.emit('task_changed', {} as never);
    await vi.advanceTimersByTimeAsync(30_000);
    bus.emit('task_changed', {} as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publishWorktrees).toHaveBeenCalledTimes(2);
  });
});
