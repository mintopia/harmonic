import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logFilePath } from '../src/daemon.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = join(repoRoot, 'dist', 'cli.js');
const relauncherPath = fileURLToPath(new URL('../src/upgrade/relauncher.ts', import.meta.url));
const guardSourcePath = fileURLToPath(new URL('../src/upgrade/boot-guard.cjs', import.meta.url));

const UNCONVERTIBLE_SETTINGS = 'global:\n  maxAttempts: 25\nworkspaces: {}\n';

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
}, 180_000);

interface Finished {
  code: number | null;
  output: string;
}

function runBuilt(dataDir: string): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [builtCli, 'serve', '--data-dir', dataDir, '--port', '0', '--host', '127.0.0.1'], { cwd: repoRoot, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

function runRelauncher(dataDir: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', relauncherPath, dataDir, JSON.stringify(['--data-dir', dataDir])], {
      stdio: 'pipe',
      env: { ...process.env, HARMONIC_RELAUNCHER_POLL_MS: '10' },
    });
    child.on('exit', (code) => resolve(code));
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('settings to workflows migration in a built Harmonic process', () => {
  it('refuses to start on an unconvertible setting: exits non-zero, names it, writes no workflow or prompt files', async () => {
    const dataDir = tempDir('harmonic-migration-refuse-');
    writeFileSync(join(dataDir, 'settings.yaml'), UNCONVERTIBLE_SETTINGS);

    const { code, output } = await runBuilt(dataDir);

    expect(code).not.toBe(0);
    expect(output).toContain('Cannot migrate setting maxAttempts');
    expect(existsSync(join(dataDir, 'workflows'))).toBe(false);
    expect(existsSync(join(dataDir, 'prompts'))).toBe(false);
    expect(readFileSync(join(dataDir, 'settings.yaml'), 'utf8')).toBe(UNCONVERTIBLE_SETTINGS);
  }, 60_000);

  it('rolls the ADR-0042 staged layout back to the previous release when the new release refuses to start', async () => {
    const dataDir = tempDir('harmonic-migration-rollback-');
    const appDir = join(dataDir, 'app');
    const v1Marker = join(dataDir, 'v1-marker.txt');
    mkdirSync(join(appDir, 'versions', '1.0.0', 'dist'), { recursive: true });
    mkdirSync(join(appDir, 'versions', '2.0.0'), { recursive: true });
    writeFileSync(join(appDir, 'versions', '1.0.0', 'dist', 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(v1Marker)}, 'v1-running'); process.exit(0);`);
    symlinkSync(join(repoRoot, 'dist'), join(appDir, 'versions', '2.0.0', 'dist'));
    symlinkSync('versions/2.0.0', join(appDir, 'current'));
    writeFileSync(join(appDir, 'boot-guard.cjs'), readFileSync(guardSourcePath, 'utf8'));
    writeFileSync(join(appDir, 'pre-2.0.0.db'), '');
    writeFileSync(join(appDir, 'pending.json'), JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db'), boots: 0 }));
    writeFileSync(join(dataDir, 'settings.yaml'), UNCONVERTIBLE_SETTINGS);

    const exitCode = await runRelauncher(dataDir);

    expect(exitCode).toBe(0);
    expect(readlinkSync(join(appDir, 'current'))).toBe('versions/1.0.0');
    expect(existsSync(join(appDir, 'rollback.json'))).toBe(true);
    expect(existsSync(join(appDir, 'pending.json'))).toBe(false);
    await waitFor(() => existsSync(v1Marker), 5_000);
    expect(readFileSync(v1Marker, 'utf8')).toBe('v1-running');
    expect(readFileSync(logFilePath(dataDir), 'utf8')).toContain('Cannot migrate setting maxAttempts');
    expect(existsSync(join(dataDir, 'workflows'))).toBe(false);
    expect(readFileSync(join(dataDir, 'settings.yaml'), 'utf8')).toBe(UNCONVERTIBLE_SETTINGS);
  }, 120_000);
});
