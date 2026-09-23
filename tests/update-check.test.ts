import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { UpdateCheck, compareStableVersions, fetchLatestVersion, type UpdateAvailabilityStore } from '../src/upgrade/update-check.js';

function store(initial: string | null = null): UpdateAvailabilityStore {
  let version = initial;
  return {
    get: async () => version,
    set: async (next) => { version = next; },
  };
}

describe('UpdateCheck', () => {
  it('records only a newer stable npm release', async () => {
    const check = new UpdateCheck({ version: '2.5.0', latest: async () => '2.6.0', store: store() });

    await check.run();

    await expect(check.getAvailableVersion()).resolves.toBe('2.6.0');
  });

  it.each([
    ['2.5.0', '2.5.0'],
    ['2.5.0', '2.4.9'],
    ['2.5.0', '2.6.0-beta.1'],
    ['2.5.0-beta.1', '2.6.0'],
  ])('does not record %s when the running version is %s', async (version, latest) => {
    const check = new UpdateCheck({ version, latest: async () => latest, store: store() });

    await check.run();

    await expect(check.getAvailableVersion()).resolves.toBeNull();
  });

  it('compares stable semantic versions numerically', () => {
    expect(compareStableVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareStableVersions('2.5.0', '2.5.0')).toBe(0);
    expect(compareStableVersions('2.5.0+build.2', '2.5.0')).toBe(0);
    expect(compareStableVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(0);
    expect(compareStableVersions('2.5.0-beta.1', '2.5.0')).toBeNull();
  });

  it('ignores a prerelease tag without clearing an earlier stable update', async () => {
    const check = new UpdateCheck({ version: '2.5.0', latest: async () => '2.7.0-beta.1', store: store('2.6.0') });

    await check.run();

    await expect(check.getAvailableVersion()).resolves.toBe('2.6.0');
  });

  it('keeps a recorded update when a later registry request fails', async () => {
    const check = new UpdateCheck({
      version: '2.5.0',
      latest: async () => { throw new Error('npm unavailable'); },
      store: store('2.6.0'),
    });

    await expect(check.run()).rejects.toThrow('npm unavailable');

    await expect(check.getAvailableVersion()).resolves.toBe('2.6.0');
  });
});

function startFakeRegistry(latest: string): Promise<{ server: Server; registry: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: '@mintopia/harmonic',
        'dist-tags': { latest },
        versions: {
          [latest]: {
            name: '@mintopia/harmonic',
            version: latest,
            dist: { tarball: `http://127.0.0.1/mintopia-harmonic-${latest}.tgz`, shasum: '0'.repeat(40) },
          },
        },
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('fake registry did not bind to a port');
      resolve({ server, registry: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe('fetchLatestVersion', () => {
  let server: Server | undefined;
  let originalRegistry: string | undefined;

  afterEach(async () => {
    if (server !== undefined) await new Promise((resolve) => server?.close(() => resolve(undefined)));
    server = undefined;
    if (originalRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = originalRegistry;
  });

  it('follows the registry npm resolves from the host config, not a hardcoded host', async () => {
    originalRegistry = process.env.npm_config_registry;
    const started = await startFakeRegistry('9.9.9');
    server = started.server;
    process.env.npm_config_registry = started.registry;

    await expect(fetchLatestVersion()).resolves.toBe('9.9.9');
  }, 20_000);
});
