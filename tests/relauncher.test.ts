import { describe, expect, it, vi } from 'vitest';
import { relaunchWithBootGuard, type LaunchedProcess, type RelauncherDependencies } from '../src/upgrade/relauncher.js';

function noWaitDependencies(overrides: Partial<RelauncherDependencies> = {}): RelauncherDependencies {
  return {
    isLocked: () => false,
    wait: async () => {},
    runGuard: () => {},
    launch: () => ({ pid: 1, onExit: () => {} }),
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
        launch: () => { calls.push('launch'); pending = false; return { pid: 7, onExit: () => {} }; },
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
          let exitCallback: (() => void) | undefined;
          queueMicrotask(() => exitCallback?.());
          return { pid: launchCalls, onExit: (callback) => { exitCallback = callback; } };
        },
        isPending: () => true,
      }),
    });

    expect(guardCalls).toBe(4);
    expect(launchCalls).toBe(4);
  });

  it('stops after one round on a timeout without treating it as a crash (does not start a second round)', async () => {
    let guardCalls = 0;
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      roundWaitMs: 10,
      roundPollMs: 5,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        launch: () => ({ pid: 1, onExit: () => {} }),
        isPending: () => true, // never clears, process never exits: eventually times out
      }),
    });

    expect(guardCalls).toBe(1);
  });

  it('continues to the next round when launch itself throws', async () => {
    let attempts = 0;
    const launch = vi.fn((): LaunchedProcess => {
      attempts += 1;
      if (attempts === 1) throw new Error('spawn failed');
      return { pid: 2, onExit: () => {} };
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
