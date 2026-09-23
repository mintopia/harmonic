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
    expect(res.body).toMatchObject({ currentVersion: '1.2.3', availableVersion: null, upgradingVersion: null });
  });

  it('reports guardMissing for a root system unit that predates the boot guard, while still allowing arming', async () => {
    server = await startServer(undefined, {
      distributionMode: 'packaged',
      version: '1.0.0',
      guardMissing: true,
      updateCheckLatest: async () => '1.1.0',
    });
    await server.api('POST', '/api/update/check');

    const state = await server.api('GET', '/api/update');
    expect(state.body).toMatchObject({ guardMissing: true });

    const arm = await server.api('POST', '/api/update/arm');
    expect(arm.status).toBe(200);
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
    expect(arm.body.error.message).toContain('Upgrading from the app is off until you re-run sudo harmonic install');
  });

  it('reports the resolved install mode and refuses to arm an external (npx/npm-global) install', async () => {
    server = await startServer(undefined, {
      distributionMode: 'packaged',
      version: '1.0.0',
      updateCheckLatest: async () => '1.1.0',
      installMode: { kind: 'external', subkind: 'npm-global', instructionFor: (version) => ({ kind: 'command', command: `npm i -g @mintopia/harmonic@${version}` }) },
    });
    await server.api('POST', '/api/update/check');

    const state = await server.api('GET', '/api/update');
    expect(state.body).toMatchObject({ mode: { kind: 'external', instruction: { kind: 'command', command: 'npm i -g @mintopia/harmonic@1.1.0' } } });

    const arm = await server.api('POST', '/api/update/arm');
    expect(arm.status).toBe(409);
    expect(arm.body.error.message).toContain("This install can't upgrade itself");
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
