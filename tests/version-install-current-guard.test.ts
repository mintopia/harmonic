import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installVersion } from '../src/upgrade/version-install.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

describe('installVersion: never deletes the directory app/current resolves to', () => {
  it('throws instead of rm-ing when the target version is the live current and did not verify as already valid', async () => {
    const dataDir = tempDir('version-install-guard-datadir-');
    const appDir = join(dataDir, 'app');
    const version = '1.0.0';
    const versionDir = join(appDir, 'versions', version);
    // A broken install: dist/cli.js is missing, so hasValidInstall says false — but app/current
    // still points here because it's the live, running version.
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, 'package.json'), JSON.stringify({ version }));
    symlinkSync(`versions/${version}`, join(appDir, 'current'));

    let rmCalled = false;
    await expect(
      installVersion({
        appDir,
        version,
        dependencies: {
          run: async () => ({}),
          mkdir: async () => {},
          rm: async () => { rmCalled = true; },
          rename: async () => {},
          fileExists: () => false,
          readFile: () => { throw new Error('ENOENT'); },
          readlink: (path) => {
            try {
              return readlinkSync(path);
            } catch {
              return null;
            }
          },
        },
      }),
    ).rejects.toThrow(/app\/current points at it/);

    expect(rmCalled).toBe(false);
    expect(readlinkSync(join(appDir, 'current'))).toBe(`versions/${version}`);
  });
});
