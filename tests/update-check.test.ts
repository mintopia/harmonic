import { describe, expect, it } from 'vitest';
import { UpdateCheck, compareStableVersions, type UpdateAvailabilityStore } from '../src/upgrade/update-check.js';

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
