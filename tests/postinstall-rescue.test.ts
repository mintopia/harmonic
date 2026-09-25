import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installManagedUpgrade, readManagedInstalledVersion } from '../src/cli-serve.js';
import { flipCurrent } from '../src/upgrade/boot-state.js';
import { installVersion } from '../src/upgrade/version-install.js';
import { createTempDirTracker, packFixtureTarball } from './helpers/upgrade-fixture.js';

const execFileAsync = promisify(execFile);
const run = (command: string, args: readonly string[]) => execFileAsync(command, [...args]);

const rescueScriptSource = readFileSync(fileURLToPath(new URL('../scripts/postinstall-rescue.cjs', import.meta.url)), 'utf8');
const rescueFixtureFiles = { 'scripts/postinstall-rescue.cjs': rescueScriptSource };
const rescueFixtureScripts = { postinstall: 'node scripts/postinstall-rescue.cjs' };

/** 2.18.1's `npm i --prefix <versionDir> <spec>`. npm 12 blocks dependency install scripts by
 * default, so this carries the operator's `allow-scripts` opt-in (keyed by the tarball path, since
 * npm matches local specs by path, not name). npm 10 ignores the unknown key. */
async function legacyNestedInstall(prefix: string, packageSpec: string): Promise<void> {
  const userConfig = join(dirname(packageSpec), 'legacy-install.npmrc');
  writeFileSync(userConfig, `allow-scripts=${packageSpec}\n`);
  await run('npm', ['i', '--userconfig', userConfig, '--prefix', prefix, packageSpec]);
}

function readManifestVersion(packageJsonPath: string): string {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
}

describe('postinstall-rescue.cjs (real npm install)', () => {
  const { tempDir, cleanupAll } = createTempDirTracker();
  afterEach(cleanupAll);

  it("rescues 2.18.1's broken nested layout for real: old verify's package.json read and a restart through app/current/dist/cli.js both resolve", async () => {
    const version = '0.0.0-rescue-green.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const dataDir = tempDir('harmonic-rescue-green-datadir-');
    const appDir = join(dataDir, 'app');
    const versionDir = join(appDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });

    await legacyNestedInstall(versionDir, packageSpec);
    await run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);

    // Old verify replicated via string concat, not path.join, to match its exact behavior.
    const packageJsonPath = `${join(appDir, 'current', 'dist')}/../package.json`;
    expect(readManifestVersion(packageJsonPath)).toBe(version);

    const { stdout } = await execFileAsync(process.execPath, [join(appDir, 'current', 'dist', 'cli.js')]);
    expect(stdout).toContain('fixture-cli');
  }, 30_000);

  it('does not act on a plain, non-matching --prefix install', async () => {
    const version = '0.0.0-rescue-noop.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const otherDir = tempDir('harmonic-rescue-other-');

    await legacyNestedInstall(otherDir, packageSpec);

    const nestedDist = join(otherDir, 'node_modules', '@mintopia', 'harmonic', 'dist');
    expect(existsSync(nestedDist)).toBe(true);
    expect(lstatSync(nestedDist).isSymbolicLink()).toBe(false);
  }, 30_000);

  it('recognizes a rescued layout as a valid install: installVersion is a no-op and never deletes the nested tree', async () => {
    const version = '0.0.0-rescue-idempotent.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const dataDir = tempDir('harmonic-rescue-idempotent-datadir-');
    const appDir = join(dataDir, 'app');
    const versionDir = join(appDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });

    await legacyNestedInstall(versionDir, packageSpec);
    await run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);
    const nestedCliPath = join(versionDir, 'node_modules', '@mintopia', 'harmonic', 'dist', 'cli.js');
    expect(existsSync(nestedCliPath)).toBe(true);

    const runCalls: string[][] = [];
    let rmCalled = false;
    const result = await installVersion({
      appDir,
      version,
      packageSpec,
      dependencies: {
        run: async (command, args) => {
          runCalls.push([command, ...args]);
          return run(command, args);
        },
        mkdir: async () => {},
        rm: async () => { rmCalled = true; },
        rename: async () => {},
        fileExists: existsSync,
        readFile: (p) => readFileSync(p, 'utf8'),
        readlink: (p) => {
          try {
            return readlinkSync(p);
          } catch {
            return null;
          }
        },
      },
    });

    expect(result).toBe(versionDir);
    expect(rmCalled).toBe(false);
    expect(runCalls).toEqual([]);
    expect(existsSync(nestedCliPath)).toBe(true);
  }, 30_000);

  it('replaces a broken nested layout that was never rescued (e.g. npm ignore-scripts=true), even when app/current points at it', async () => {
    const version = '0.0.0-rescue-recover.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const dataDir = tempDir('harmonic-rescue-recover-datadir-');
    const appDir = join(dataDir, 'app');
    const versionDir = join(appDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });

    await run('npm', ['i', '--prefix', versionDir, '--ignore-scripts', packageSpec]);
    await run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);
    expect(existsSync(join(versionDir, 'dist'))).toBe(false);
    expect(existsSync(join(versionDir, 'node_modules', '@mintopia', 'harmonic', 'dist', 'cli.js'))).toBe(true);

    const result = await installVersion({
      appDir,
      version,
      packageSpec,
      dependencies: {
        run,
        mkdir: async (p) => { mkdirSync(p, { recursive: true }); },
        rm: async (p) => { await rm(p, { recursive: true, force: true }); },
        rename: async (from, to) => { await rename(from, to); },
        fileExists: existsSync,
        readFile: (p) => readFileSync(p, 'utf8'),
        readlink: (p) => {
          try {
            return readlinkSync(p);
          } catch {
            return null;
          }
        },
      },
    });

    expect(result).toBe(versionDir);
    expect(existsSync(join(versionDir, 'dist', 'cli.js'))).toBe(true);
    expect(lstatSync(join(versionDir, 'dist')).isSymbolicLink()).toBe(false);
    const { stdout } = await execFileAsync(process.execPath, [join(versionDir, 'dist', 'cli.js')]);
    expect(stdout).toContain('fixture-cli');
  }, 30_000);

  it('does not act on the new installVersion staging install: versions/<v>/dist stays a real directory', async () => {
    const version = '0.0.0-rescue-noop.2';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const dataDir = tempDir('harmonic-rescue-staging-datadir-');

    await installManagedUpgrade({ dataDir, target: version, run, packageSpec });

    const distPath = join(dataDir, 'app', 'versions', version, 'dist');
    expect(existsSync(join(distPath, 'cli.js'))).toBe(true);
    expect(lstatSync(distPath).isSymbolicLink()).toBe(false);
  }, 30_000);
});

describe('readManagedInstalledVersion on a rescued layout (real filesystem)', () => {
  const { tempDir, cleanupAll } = createTempDirTracker();
  afterEach(cleanupAll);

  it("reads the running version from app/current's symlink target, not the rescued layout's npm wrapper package.json", async () => {
    const version = '0.0.0-rescue-previous.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const dataDir = tempDir('harmonic-rescue-previous-datadir-');
    const appDir = join(dataDir, 'app');
    const versionDir = join(appDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });

    await legacyNestedInstall(versionDir, packageSpec);
    flipCurrent({ appDir, version });

    const wrapperManifest = JSON.parse(readFileSync(join(versionDir, 'package.json'), 'utf8'));
    expect(wrapperManifest.version).toBeUndefined();

    const previous = readManagedInstalledVersion({ dataDir, readlink: readlinkSync, fileExists: existsSync });
    expect(previous).toBe(version);
  }, 30_000);
});
