import { describe, expect, it, vi } from 'vitest';
import { UpgradeSwap, type UpgradeSwapDependencies } from '../src/upgrade/upgrade-swap.js';

function subject(overrides: Partial<UpgradeSwapDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: UpgradeSwapDependencies = {
    install: vi.fn(async (version: string) => { calls.push(`install:${version}`); }),
    verify: vi.fn(async () => {}),
    commit: vi.fn(async (version: string) => { calls.push(`commit:${version}`); }),
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
  it('installs the pinned version, verifies it, commits, and only then hands off the lock and exits', async () => {
    const { swap, calls } = subject();

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'swapped' });

    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:succeeded',
      'log:commit:started', 'operation:upgrade.commit', 'commit:2.6.0', 'log:commit:succeeded',
      'log:relaunch:started', 'operation:upgrade.relaunch', 'relauncher', 'log:relaunch:succeeded',
      'log:release-lock:started', 'operation:upgrade.release-lock', 'release-lock', 'log:release-lock:succeeded',
      'log:exit:started', 'operation:upgrade.exit', 'exit', 'log:exit:succeeded',
    ]);
  });

  it('waits for idle after verify and before commit/relaunch/release-lock when waitForIdle is provided', async () => {
    const { swap, calls } = subject({ waitForIdle: vi.fn(async () => { calls.push('await-idle'); return true; }) });

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'swapped' });

    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:succeeded',
      'log:await-idle:started', 'operation:upgrade.await-idle', 'await-idle', 'log:await-idle:succeeded',
      'log:commit:started', 'operation:upgrade.commit', 'commit:2.6.0', 'log:commit:succeeded',
      'log:relaunch:started', 'operation:upgrade.relaunch', 'relauncher', 'log:relaunch:succeeded',
      'log:release-lock:started', 'operation:upgrade.release-lock', 'release-lock', 'log:release-lock:succeeded',
      'log:exit:started', 'operation:upgrade.exit', 'exit', 'log:exit:succeeded',
    ]);
  });

  it('skips the await-idle step entirely when waitForIdle is not provided', async () => {
    const { swap, calls } = subject();

    await swap.execute({ version: '2.6.0' });

    expect(calls.some((c) => c.includes('await-idle'))).toBe(false);
  });

  it('aborts before commit when waitForIdle times out with work still running', async () => {
    const { swap, calls, dependencies } = subject({ waitForIdle: vi.fn(async () => false) });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result).toEqual({ kind: 'idle-timeout' });
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.abort).toHaveBeenCalledOnce();
    expect(dependencies.releaseLock).not.toHaveBeenCalled();
    expect(dependencies.exit).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:succeeded',
      'log:await-idle:started', 'operation:upgrade.await-idle', 'log:await-idle:succeeded',
      'log:abort:started', 'operation:upgrade.abort', 'abort', 'log:abort:succeeded',
    ]);
  });

  it('stops before commit when a cancellation is already requested, without touching commit or await-idle', async () => {
    const cancellation = { shouldContinue: () => false, enterCommit: () => false };
    const { swap, dependencies } = subject({ cancellation, waitForIdle: vi.fn(async () => true) });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(dependencies.waitForIdle).not.toHaveBeenCalled();
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.abort).not.toHaveBeenCalled();
  });

  it('stops before commit when cancelled between await-idle and commit', async () => {
    let cancelled = false;
    const cancellation = { shouldContinue: () => !cancelled, enterCommit: () => !cancelled };
    const { swap, dependencies } = subject({ cancellation, waitForIdle: vi.fn(async () => { cancelled = true; return true; }) });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(dependencies.commit).not.toHaveBeenCalled();
  });

  it('lets a cancel that arrives after commit is entered lose the race: commit still runs', async () => {
    const cancellation = { shouldContinue: () => true, enterCommit: () => true };
    const { swap, dependencies } = subject({ cancellation });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result).toEqual({ kind: 'swapped' });
    expect(dependencies.commit).toHaveBeenCalledWith('2.6.0');
  });

  it('hands the restart to systemd after commit, without spawning a relauncher', async () => {
    const { swap, calls, dependencies } = subject({ managedBy: 'systemd' });

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'swapped' });

    expect(dependencies.spawnRelauncher).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:succeeded',
      'log:commit:started', 'operation:upgrade.commit', 'commit:2.6.0', 'log:commit:succeeded',
      'log:release-lock:started', 'operation:upgrade.release-lock', 'release-lock', 'log:release-lock:succeeded',
      'log:exit:started', 'operation:upgrade.exit', 'exit', 'log:exit:succeeded',
    ]);
  });

  it('does not install or restart while a legacy systemd layout requires migration', async () => {
    const { swap, calls, dependencies } = subject({ managedBy: 'systemd', migrationRequired: true });

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'migration-required' });

    expect(dependencies.install).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('keeps the relauncher for init.d', async () => {
    const { swap, dependencies } = subject({ managedBy: 'init.d' });

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'swapped' });

    expect(dependencies.spawnRelauncher).toHaveBeenCalledOnce();
  });

  it('aborts without committing, releasing the lock, or exiting when installation fails', async () => {
    const installError = new Error('npm unavailable');
    const { swap, calls, dependencies } = subject({ install: vi.fn(async () => { throw installError; }) });

    await expect(swap.execute({ version: '2.6.0' })).resolves.toEqual({ kind: 'aborted', error: installError });

    expect(dependencies.abort).toHaveBeenCalledWith(installError);
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'log:install:failed',
      'log:abort:started', 'operation:upgrade.abort', 'abort', 'log:abort:succeeded',
    ]);
  });

  it('aborts without committing, releasing the lock, or exiting when verification fails', async () => {
    const verifyError = new Error('installed version 2.6.1 does not match pinned version 2.6.0');
    const { swap, calls, dependencies } = subject({ verify: vi.fn(async () => { throw verifyError; }) });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result).toEqual({ kind: 'aborted', error: verifyError });
    expect(dependencies.abort).toHaveBeenCalledOnce();
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.releaseLock).not.toHaveBeenCalled();
    expect(dependencies.exit).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:failed',
      'log:abort:started', 'operation:upgrade.abort', 'abort', 'log:abort:succeeded',
    ]);
  });

  it('aborts without relaunching, releasing the lock, or exiting when commit fails (e.g. the DB snapshot did)', async () => {
    const commitError = new Error('ENOSPC: no space left on device');
    const { swap, calls, dependencies } = subject({ commit: vi.fn(async () => { throw commitError; }) });

    const result = await swap.execute({ version: '2.6.0' });

    expect(result).toEqual({ kind: 'aborted', error: commitError });
    expect(dependencies.abort).toHaveBeenCalledOnce();
    expect(dependencies.spawnRelauncher).not.toHaveBeenCalled();
    expect(dependencies.releaseLock).not.toHaveBeenCalled();
    expect(dependencies.exit).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'log:install:started', 'operation:upgrade.install', 'install:2.6.0', 'log:install:succeeded',
      'log:verify:started', 'operation:upgrade.verify', 'log:verify:succeeded',
      'log:commit:started', 'operation:upgrade.commit', 'log:commit:failed',
      'log:abort:started', 'operation:upgrade.abort', 'abort', 'log:abort:succeeded',
    ]);
  });
});
