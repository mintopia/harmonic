import { describe, expect, it, vi } from 'vitest';
import { relaunchWithBootGuard, type LaunchedProcess, type RelauncherDependencies } from '../src/upgrade/relauncher.js';

/** A fake `LaunchedProcess` whose `onExit` supports multiple subscribers, like `child.once('exit', cb)` in production. */
function fakeChild(pid: number, kill: (signal: NodeJS.Signals) => void = () => {}): { child: LaunchedProcess; exit: () => void } {
  const listeners: Array<() => void> = [];
  return {
    child: {
      pid,
      onExit: (callback) => { listeners.push(callback); },
      kill,
    },
    exit: () => { listeners.forEach((listener) => { listener(); }); },
  };
}

function noWaitDependencies(overrides: Partial<RelauncherDependencies> = {}): RelauncherDependencies {
  return {
    isLocked: () => false,
    wait: async () => {},
    runGuard: () => {},
    launch: () => fakeChild(1).child,
    isPending: () => false,
    ...overrides,
  };
}

describe('relaunchWithBootGuard', () => {
  it('waits for the data-directory lock to release before the first round', async () => {
    let locked = true;
    const calls: string[] = [];
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: ['--data-dir', '/tmp/harmonic'],
      dependencies: noWaitDependencies({
        isLocked: () => { calls.push('isLocked'); return locked; },
        wait: async () => { calls.push('wait'); locked = false; },
        runGuard: () => calls.push('runGuard'),
      }),
    });

    expect(calls).toEqual(['isLocked', 'wait', 'isLocked', 'runGuard']);
  });

  it('runs the guard then launches once and stops as soon as pending.json clears', async () => {
    const calls: string[] = [];
    let pending = true;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      dependencies: noWaitDependencies({
        runGuard: () => calls.push('guard'),
        launch: () => { calls.push('launch'); pending = false; return fakeChild(7).child; },
        isPending: () => pending,
      }),
    });

    expect(calls).toEqual(['guard', 'launch']);
  });

  it('retries up to maxRounds when every launch exits immediately, then gives up', async () => {
    let guardCalls = 0;
    let launchCalls = 0;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 4,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        launch: () => {
          launchCalls += 1;
          const { child, exit } = fakeChild(launchCalls);
          queueMicrotask(exit);
          return child;
        },
        isPending: () => true,
      }),
    });

    expect(guardCalls).toBe(4);
    expect(launchCalls).toBe(4);
  });

  it('does not start another round while the child from a timed-out round never exits: kills it once and stops', async () => {
    let guardCalls = 0;
    let launchCalls = 0;
    const killSignals: string[] = [];
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 4,
      overallDeadlineMs: 20,
      roundPollMs: 5,
      killGraceMs: 5,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        launch: () => {
          launchCalls += 1;
          // never exits: nothing but the overall deadline can end the round
          return fakeChild(launchCalls, (signal) => { killSignals.push(signal); }).child;
        },
        isPending: () => true, // never clears
      }),
    });

    expect(guardCalls).toBe(1);
    expect(launchCalls).toBe(1);
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not run the next guard round when the child exits but the data-dir lock never clears', async () => {
    let guardCalls = 0;
    let launched = false;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 4,
      exitPollMs: 5,
      exitMaxWaitMs: 20,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        // free before launch (so the pre-round lock wait passes), stuck forever after — as if the exiting process were still tearing down
        isLocked: () => launched,
        launch: () => {
          launched = true;
          const { child, exit } = fakeChild(1);
          queueMicrotask(exit);
          return child;
        },
        isPending: () => true,
      }),
    });

    expect(guardCalls).toBe(1);
  });

  it('runs the next guard round once a process that exited on its own also clears the lock', async () => {
    let guardCalls = 0;
    let launchCalls = 0;
    let pending = true;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 2,
      exitPollMs: 5,
      exitMaxWaitMs: 1000,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        launch: () => {
          launchCalls += 1;
          const { child, exit } = fakeChild(launchCalls);
          queueMicrotask(exit);
          if (launchCalls === 2) pending = false;
          return child;
        },
        isPending: () => pending,
      }),
    });

    expect(guardCalls).toBe(2);
    expect(launchCalls).toBe(2);
  });

  it('gives up mid-round when the overall safety cap is exceeded, without starting another round', async () => {
    let guardCalls = 0;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 4,
      overallDeadlineMs: 15,
      roundPollMs: 5,
      killGraceMs: 5,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        launch: () => fakeChild(1).child,
        isPending: () => true,
      }),
    });

    expect(guardCalls).toBe(1);
  });

  it('continues to the next round when launch itself throws', async () => {
    let attempts = 0;
    const launch = vi.fn((): LaunchedProcess => {
      attempts += 1;
      if (attempts === 1) throw new Error('spawn failed');
      const { child, exit } = fakeChild(2);
      queueMicrotask(exit);
      return child;
    });
    let pending = true;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      dependencies: noWaitDependencies({
        launch: () => {
          const result = launch();
          pending = false;
          return result;
        },
        isPending: () => pending,
      }),
    });

    expect(attempts).toBe(2);
  });
});
