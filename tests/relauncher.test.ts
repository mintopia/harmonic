import { describe, expect, it } from 'vitest';
import { relaunchWhenLockIsFree } from '../src/upgrade/relauncher.js';

describe('upgrade relauncher', () => {
  it('waits for the data-directory lock, then starts the installed CLI with its original serve arguments', async () => {
    let locked = true;
    const launched: Array<{ dataDir: string; cliPath: string; serveArgs: string[] }> = [];

    await relaunchWhenLockIsFree({
      dataDir: '/tmp/harmonic',
      cliPath: '/global/node_modules/@mintopia/harmonic/dist/cli.js',
      serveArgs: ['--port', '4701', '--data-dir', '/tmp/harmonic'],
      pollMs: 1,
      dependencies: {
        isLocked: () => locked,
        wait: async () => { locked = false; },
        launch: (input) => { launched.push(input); return 42; },
      },
    });

    expect(launched).toEqual([{
      dataDir: '/tmp/harmonic',
      cliPath: '/global/node_modules/@mintopia/harmonic/dist/cli.js',
      serveArgs: ['--port', '4701', '--data-dir', '/tmp/harmonic'],
    }]);
  });
});
