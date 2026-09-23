import { afterEach, describe, expect, it } from 'vitest';
import { startServer, waitFor, type TestServer } from './helpers.js';

describe('upgrade coordinator does not block requests for the whole idle handoff', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close().catch(() => {});
  });

  it('resolves a request needing the coordinator lock promptly instead of queueing behind the in-progress swap', async () => {
    let releaseSwap: (() => void) | undefined;
    const swapPaused = new Promise<void>((resolve) => { releaseSwap = resolve; });

    server = await startServer(undefined, {
      version: '2.0.0',
      distributionMode: 'packaged',
      updateCheckLatest: async () => '2.6.0',
      // Simulates the real install+verify+relaunch+release-lock swap, which
      // can run for minutes and, in production, ends by calling app.close()
      // and process.exit().
      onUpgradeIdle: async () => { await swapPaused; },
    });

    await server.app.ctx.updateCheck.run();
    await server.api('POST', '/api/update/arm');
    await waitFor(async () => {
      const state = await server!.app.ctx.upgrade.state();
      return state.phase.kind === 'upgrading' ? true : undefined;
    });

    const start = Date.now();
    const cancel = await server.api('DELETE', '/api/update/arm');
    const elapsed = Date.now() - start;
    releaseSwap?.();

    expect(elapsed).toBeLessThan(1000);
    expect(cancel.status).not.toBe(0);
  }, 10_000);
});
