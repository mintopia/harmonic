import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installManagedUpgrade, readManagedInstalledVersion } from '../src/cli-serve.js';
import { flipCurrent } from '../src/upgrade/boot-state.js';
import { createTempDirTracker, packFixtureTarball } from './helpers/upgrade-fixture.js';

const execFileAsync = promisify(execFile);
const run = (command: string, args: readonly string[]) => execFileAsync(command, [...args]);

const rescueScriptSource = readFileSync(fileURLToPath(new URL('../scripts/postinstall-rescue.cjs', import.meta.url)), 'utf8');
const rescueFixtureFiles = { 'scripts/postinstall-rescue.cjs': rescueScriptSource };
const rescueFixtureScripts = { postinstall: 'node scripts/postinstall-rescue.cjs' };

function readManifestVersion(packageJsonPath: string): string {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
}

describe('postinstall-rescue.cjs (real npm install)', () => {
  const { tempDir, cleanupAll } = createTempDirTracker();
  afterEach(cleanupAll);

  it("2.18.1's exact broken sequence, without the rescue script, leaves current/dist unreadable (red baseline)", async () => {
    const version = '0.0.0-rescue-red.1';
    const packageSpec = packFixtureTarball(tempDir, { version });
    const dataDir = tempDir('harmonic-rescue-red-datadir-');
    const appDir = join(dataDir, 'app');
    const versionDir = join(appDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });

    await run('npm', ['i', '--prefix', versionDir, packageSpec]);
    await run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);

    expect(existsSync(join(versionDir, 'dist'))).toBe(false);
    const packageJsonPath = `${join(appDir, 'current', 'dist')}/../package.json`;
    expect(() => readManifestVersion(packageJsonPath)).toThrow();
  }, 30_000);

  it("rescues 2.18.1's broken nested layout for real: old verify's package.json read and a restart through app/current/dist/cli.js both resolve (green)", async () => {
    const version = '0.0.0-rescue-green.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const dataDir = tempDir('harmonic-rescue-green-datadir-');
    const appDir = join(dataDir, 'app');
    const versionDir = join(appDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });

    // 2.18.1's exact broken sequence.
    await run('npm', ['i', '--prefix', versionDir, packageSpec]);
    await run('ln', ['-sfn', `versions/${version}`, join(appDir, 'current')]);

    // Old verify: `${join(dataDir,'app','current','dist')}/../package.json`, string concat, not path.join.
    const packageJsonPath = `${join(appDir, 'current', 'dist')}/../package.json`;
    expect(readManifestVersion(packageJsonPath)).toBe(version);

    const { stdout } = await execFileAsync(process.execPath, [join(appDir, 'current', 'dist', 'cli.js')]);
    expect(stdout).toContain('fixture-cli');
  }, 30_000);

  it('does not act on a plain, non-matching --prefix install', async () => {
    const version = '0.0.0-rescue-noop.1';
    const packageSpec = packFixtureTarball(tempDir, { version, scripts: rescueFixtureScripts, files: rescueFixtureFiles });
    const otherDir = tempDir('harmonic-rescue-other-');

    await run('npm', ['i', '--prefix', otherDir, packageSpec]);

    const nestedDist = join(otherDir, 'node_modules', '@mintopia', 'harmonic', 'dist');
    expect(existsSync(nestedDist)).toBe(true);
    expect(lstatSync(nestedDist).isSymbolicLink()).toBe(false);
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

    await run('npm', ['i', '--prefix', versionDir, packageSpec]);
    flipCurrent({ appDir, version });

    // The npm wrapper manifest npm write at versions/<v>/package.json has no real version field — the
    // bug that used to feed 'unknown' into writePending's `previous`.
    const wrapperManifest = JSON.parse(readFileSync(join(versionDir, 'package.json'), 'utf8'));
    expect(wrapperManifest.version).toBeUndefined();

    const previous = readManagedInstalledVersion({ dataDir, readlink: readlinkSync, fileExists: existsSync });
    expect(previous).toBe(version);
  }, 30_000);
});
