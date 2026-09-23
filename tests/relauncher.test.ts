import { describe, expect, it, vi } from 'vitest';
import { relaunchWithBootGuard, type LaunchedProcess, type RelauncherDependencies } from '../src/upgrade/relauncher.js';

function noWaitDependencies(overrides: Partial<RelauncherDependencies> = {}): RelauncherDependencies {
  return {
    isLocked: () => false,
    wait: async () => {},
    runGuard: () => {},
    launch: () => ({ pid: 1, onExit: () => {}, kill: () => {} }),
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
        launch: () => { calls.push('launch'); pending = false; return { pid: 7, onExit: () => {}, kill: () => {} }; },
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
          return { pid: launchCalls, onExit: (callback) => { exitCallback = callback; }, kill: () => {} };
        },
        isPending: () => true,
      }),
    });

    expect(guardCalls).toBe(4);
    expect(launchCalls).toBe(4);
  });

  it('a round that times out kills the hung child (SIGTERM then SIGKILL) and moves to the next round, giving up after maxRounds', async () => {
    let guardCalls = 0;
    let launchCalls = 0;
    const killSignals: string[] = [];
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 3,
      roundWaitMs: 10,
      roundPollMs: 5,
      killGraceMs: 10,
      dependencies: noWaitDependencies({
        runGuard: () => { guardCalls += 1; },
        launch: () => {
          launchCalls += 1;
          return {
            pid: launchCalls,
            onExit: () => {}, // never exits: every round times out
            kill: (signal) => { killSignals.push(signal); },
          };
        },
        isPending: () => true, // never clears: every round times out
      }),
    });

    expect(guardCalls).toBe(3);
    expect(launchCalls).toBe(3);
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
  });

  it('does not escalate to SIGKILL when the child exits right after SIGTERM', async () => {
    const killSignals: string[] = [];
    const onExitCallbacks: Array<() => void> = [];
    await relaunchWithBootGuard({
      dataDir: '/tmp/harmonic',
      serveArgs: [],
      maxRounds: 1,
      roundWaitMs: 10,
      roundPollMs: 5,
      killGraceMs: 10,
      dependencies: noWaitDependencies({
        launch: () => ({
          pid: 1,
          onExit: (callback) => { onExitCallbacks.push(callback); },
          kill: (signal) => {
            killSignals.push(signal);
            if (signal === 'SIGTERM') onExitCallbacks.forEach((callback) => { callback(); });
          },
        }),
        isPending: () => true, // never clears: the round times out and triggers a kill
      }),
    });

    expect(killSignals).toEqual(['SIGTERM']);
  });

  it('continues to the next round when launch itself throws', async () => {
    let attempts = 0;
    const launch = vi.fn((): LaunchedProcess => {
      attempts += 1;
      if (attempts === 1) throw new Error('spawn failed');
      return { pid: 2, onExit: () => {}, kill: () => {} };
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
