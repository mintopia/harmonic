import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from './helpers.js';

describe('Update routes (issue #638)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('GET /api/update reports the running version', async () => {
    server = await startServer(undefined, {
      distributionMode: 'packaged',
      version: '1.2.3',
      updateCheckLatest: async () => '1.2.3',
    });

    const res = await server.api('GET', '/api/update');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currentVersion: '1.2.3', availableVersion: null });
  });

  it('reports a required systemd migration and refuses to arm an update', async () => {
    server = await startServer(undefined, {
      distributionMode: 'packaged',
      version: '1.0.0',
      migrationRequired: true,
      updateCheckLatest: async () => '1.1.0',
    });

    expect((await server.api('GET', '/api/update')).body).toMatchObject({ migrationRequired: true });
    const arm = await server.api('POST', '/api/update/arm');
    expect(arm.status).toBe(409);
    expect(arm.body.error.message).toContain('Auto-upgrade is disabled until you re-run sudo harmonic install');
  });

  it('POST /api/update/check finds and persists a newer version on demand', async () => {
    server = await startServer(undefined, {
      distributionMode: 'packaged',
      version: '1.0.0',
      updateCheckLatest: async () => '1.1.0',
    });

    const checked = await server.api('POST', '/api/update/check');

    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ currentVersion: '1.0.0', availableVersion: '1.1.0' });

    const state = await server.api('GET', '/api/update');
    expect(state.body).toMatchObject({ currentVersion: '1.0.0', availableVersion: '1.1.0' });
  });

  it('POST /api/update/check 409s on a non-packaged (source) instance', async () => {
    server = await startServer(undefined, { distributionMode: 'source', version: '1.0.0' });

    const res = await server.api('POST', '/api/update/check');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invalid_state');
  });
});
