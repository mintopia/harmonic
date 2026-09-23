import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

const relauncherPath = fileURLToPath(new URL('../src/upgrade/relauncher.ts', import.meta.url));
const guardSourcePath = fileURLToPath(new URL('../src/upgrade/boot-guard.cjs', import.meta.url));

function seedVersion(appDir: string, version: string, cliJsContents: string): void {
  mkdirSync(join(appDir, 'versions', version, 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'versions', version, 'dist', 'cli.js'), cliJsContents);
}

function join(...segments: string[]): string {
  return segments.join('/');
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runRelauncher(dataDir: string, env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', relauncherPath, dataDir, JSON.stringify(['--data-dir', dataDir])],
      { stdio: 'pipe', env: { ...process.env, ...env } },
    );
    child.on('exit', (code) => resolve(code));
  });
}

describe('relauncher rounds (real process, real boot guard)', () => {
  it('a broken release rolls back across restart attempts and leaves the previous version running', async () => {
    const dataDir = tempDir('relauncher-rounds-broken-');
    const appDir = join(dataDir, 'app');
    const markerPath = join(dataDir, 'v1-marker.txt');
    seedVersion(appDir, '1.0.0', `
      require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'v1-running');
      process.exit(0);
    `);
    seedVersion(appDir, '2.0.0', "throw new Error('v2 is broken');");
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'boot-guard.cjs'), readFileSync(guardSourcePath, 'utf8'));
    writeFileSync(join(appDir, 'pre-2.0.0.db'), '');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db'), boots: 0 }));
    writeFileSync(join(dataDir, 'harmonic.db'), '');

    const exitCode = await runRelauncher(dataDir, { HARMONIC_RELAUNCHER_POLL_MS: '10', HARMONIC_RELAUNCHER_ROUND_WAIT_MS: '2000' });

    expect(exitCode).toBe(0);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(existsSync(join(appDir, 'rollback.json'))).toBe(true);
    await waitFor(() => existsSync(markerPath), 5_000);
    expect(readFileSync(markerPath, 'utf8')).toBe('v1-running');
  }, 20_000);

  it('a healthy release clears pending.json after a single round', async () => {
    const dataDir = tempDir('relauncher-rounds-healthy-');
    const appDir = join(dataDir, 'app');
    seedVersion(appDir, '1.0.0', '');
    seedVersion(appDir, '2.0.0', `
      const fs = require('node:fs');
      const path = require('node:path');
      const dataDirIndex = process.argv.indexOf('--data-dir');
      const dataDir = process.argv[dataDirIndex + 1];
      fs.unlinkSync(path.join(dataDir, 'app', 'pending.json'));
      process.exit(0);
    `);
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'boot-guard.cjs'), readFileSync(guardSourcePath, 'utf8'));
    writeFileSync(join(appDir, 'pre-2.0.0.db'), '');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db'), boots: 0 }));

    const exitCode = await runRelauncher(dataDir, { HARMONIC_RELAUNCHER_POLL_MS: '10', HARMONIC_RELAUNCHER_ROUND_WAIT_MS: '2000' });

    expect(exitCode).toBe(0);
    expect(existsSync(join(appDir, 'pending.json'))).toBe(false);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    expect(existsSync(join(appDir, 'rollback.json'))).toBe(false);
  }, 20_000);
});
