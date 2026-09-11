import { describe, expect, it, vi } from 'vitest';
import { UpgradeSwap, type UpgradeSwapDependencies } from '../src/upgrade/upgrade-swap.js';

function subject(overrides: Partial<UpgradeSwapDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: UpgradeSwapDependencies = {
    install: vi.fn(async (version: string) => { calls.push(`install:${version}`); }),
    installedVersion: vi.fn(async () => '2.6.0'),
    spawnRelauncher: vi.fn(async () => { calls.push('relauncher'); }),
    releaseLock: vi.fn(async () => { calls.push('release-lock'); }),
    exit: vi.fn(() => { calls.push('exit'); }),
    abort: vi.fn(async () => { calls.push('abort'); }),
    operation: async ({ type }, work) => {
      calls.push(`operation:${type}`);
      return work();
    },
    log: (event) => { calls.push(`log:${event.action}:${event.outcome}`); },
    ...overrides,
  };
  return { swap: new UpgradeSwap(dependencies), calls, dependencies };
}

describe('UpgradeSwap', () => {
  it('installs the pinned version, verifies it, and only then hands off the lock and exits', async () => {
    const { swap, calls } = subject();

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'swapped' });

    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:succeeded',
      'log:relaunch:started', 'operation:upgrade.relaunch', 'relauncher', 'log:relaunch:succeeded',
      'log:release-lock:started', 'operation:upgrade.release-lock', 'release-lock', 'log:release-lock:succeeded',
      'log:exit:started', 'operation:upgrade.exit', 'exit', 'log:exit:succeeded',
    ]);
  });

  it('aborts without releasing the lock or exiting when installation fails', async () => {
    const installError = new Error('npm unavailable');
    const { swap, calls, dependencies } = subject({ install: vi.fn(async () => { throw installError; }) });

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'aborted', error: installError });

    expect(dependencies.abort).toHaveBeenCalledWith(installError);
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'log:install:failed',
      'log:abort:started', 'operation:upgrade.abort', 'abort', 'log:abort:succeeded',
    ]);
  });

  it('aborts without releasing the lock or exiting when the installed version differs from the pin', async () => {
    const { swap, calls, dependencies } = subject({ installedVersion: async () => '2.6.1' });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result.kind).toBe('aborted');
    if (result.kind === 'aborted') expect(result.error.message).toBe('installed version 2.6.1 does not match pinned version 2.6.0');
    expect(dependencies.abort).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:failed',
      'log:abort:started', 'operation:upgrade.abort', 'abort', 'log:abort:succeeded',
    ]);
  });
});
