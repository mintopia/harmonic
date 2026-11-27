import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { UpdateCheck, fetchPublishedVersions, parsePublishedVersions, type UpdateAvailabilityStore } from '../src/upgrade/update-check.js';
import { compareStableVersions } from '../src/domain/stable-version.js';

function store(initial: string | null = null): UpdateAvailabilityStore {
  let version = initial;
  return {
    get: async () => version,
    set: async (next) => { version = next; },
  };
}

describe('UpdateCheck', () => {
  it('records only a newer stable npm release', async () => {
    const check = new UpdateCheck({ version: '2.5.0', published: async () => ['2.4.0', '2.5.0', '2.6.0'], store: store() });

    await check.run();

    await expect(check.getAvailableVersion()).resolves.toBe('2.6.0');
  });

  it('picks the newest release in the running major, never a later major', async () => {
    const check = new UpdateCheck({
      version: '2.27.0',
      published: async () => ['2.27.0', '2.27.1', '2.28.0', '2.28.1-beta.1', '3.0.0', '3.1.0'],
      store: store(),
    });

    await check.run();

    await expect(check.getAvailableVersion()).resolves.toBe('2.28.0');
  });

  it('clears a recorded update once only a later major is newer', async () => {
    const check = new UpdateCheck({ version: '2.28.0', published: async () => ['2.28.0', '3.0.0'], store: store('3.0.0') });

    await check.run();

    await expect(check.getAvailableVersion()).resolves.toBeNull();
  });

  it.each([
    ['2.5.0', ['2.5.0']],
    ['2.5.0', ['2.4.9']],
    ['2.5.0', ['2.6.0-beta.1']],
    ['2.5.0', ['3.0.0']],
    ['2.5.0-beta.1', ['2.6.0']],
  ])('does not record an update when running %s and npm has %j', async (version, published) => {
    const check = new UpdateCheck({ version, published: async () => published, store: store() });

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

  it('keeps a recorded update when a later registry request fails', async () => {
    const check = new UpdateCheck({
      version: '2.5.0',
      published: async () => { throw new Error('npm unavailable'); },
      store: store('2.6.0'),
    });

    await expect(check.run()).rejects.toThrow('npm unavailable');

    await expect(check.getAvailableVersion()).resolves.toBe('2.6.0');
  });
});

function startFakeRegistry(published: string[]): Promise<{ server: Server; registry: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        name: '@mintopia/harmonic',
        'dist-tags': { latest: published.at(-1) },
        versions: Object.fromEntries(published.map((version) => [version, {
          name: '@mintopia/harmonic',
          version,
          dist: { tarball: `http://127.0.0.1/mintopia-harmonic-${version}.tgz`, shasum: '0'.repeat(40) },
        }])),
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('fake registry did not bind to a port');
      resolve({ server, registry: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe('fetchPublishedVersions', () => {
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
    const started = await startFakeRegistry(['9.9.8', '9.9.9']);
    server = started.server;
    process.env.npm_config_registry = started.registry;

    await expect(fetchPublishedVersions()).resolves.toEqual(['9.9.8', '9.9.9']);
  }, 20_000);
});

describe('parsePublishedVersions', () => {
  it.each([
    ['npm 10 array', '[ "2.18.0", "2.18.1" ]', ['2.18.0', '2.18.1']],
    ['npm 10 single version', '"2.18.1"', ['2.18.1']],
    ['npm 12 wrapped array', '[ [ "2.18.0", "2.18.1" ] ]', ['2.18.0', '2.18.1']],
  ])('reads the version list from %s output', (_shape, stdout, expected) => {
    expect(parsePublishedVersions(stdout)).toEqual(expected);
  });

  it.each([
    ['an empty array', '[]'],
    ['a non-string entry', '[ "2.18.1", 3 ]'],
    ['an object', '{ "latest": "2.18.1" }'],
    ['invalid JSON', 'npm warn something'],
  ])('rejects %s', (_case, stdout) => {
    expect(() => parsePublishedVersions(stdout)).toThrow();
  });
});
