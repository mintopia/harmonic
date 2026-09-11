import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

describe('failed idle upgrade', () => {
  let server: TestServer | undefined;

  afterEach(async () => { await server?.close(); });

  it('unarms the update and restores the Auto-Runner switch', async () => {
    server = await startServer(undefined, {
      onUpgradeIdle: async () => { throw new Error('npm install failed'); },
      updateCheckLatest: async () => '2.6.0',
    });
    const initialAutoRunner = server.app.ctx.settingsStore.getGlobal().autoRunner.enabled;
    await server.app.ctx.updateCheck.run();

    await server.app.ctx.upgrade.arm();

    await expect(server.app.ctx.upgrade.state()).resolves.toEqual({
      version: '2.6.0',
      armedVersion: null,
      autoRunnerWasEnabled: null,
    });
    expect(server.app.ctx.settingsStore.getGlobal().autoRunner.enabled).toBe(initialAutoRunner);
  });
});
