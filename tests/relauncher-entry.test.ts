import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDaemon, logFilePath } from '../src/daemon.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(repoRoot, 'src');

function copySrcToWeirdPath(): string {
  const parent = mkdtempSync(join(tmpdir(), 'harmonic-relauncher-'));
  const weird = join(parent, 'weird dir café');
  mkdirSync(weird);
  cpSync(srcRoot, weird, { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules'), join(weird, 'node_modules'));
  return join(weird, 'upgrade', 'relauncher.ts');
}

const cleanupDirs: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('relauncher entry guard', () => {
  it('runs main() when invoked from a path containing a space and non-ASCII character', async () => {
    const relauncherPath = copySrcToWeirdPath();
    const dataDir = freshDir('harmonic-relauncher-data-');
    const markerPath = join(freshDir('harmonic-relauncher-marker-'), 'launched.marker');
    const fakeCliDir = freshDir('harmonic-relauncher-cli-');
    const fakeCliPath = join(fakeCliDir, 'fake-cli.js');
    writeFileSync(fakeCliPath, "require('fs').writeFileSync(process.argv[3], 'launched');\n");

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', relauncherPath, dataDir, fakeCliPath, JSON.stringify([markerPath])],
      { stdio: 'pipe', env: { ...process.env, HARMONIC_RELAUNCHER_POLL_MS: '10' } },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    await waitFor(() => existsSync(markerPath), 10_000).catch(() => {});
    if (!existsSync(markerPath)) console.error('relauncher stderr:', stderr);

    expect(existsSync(markerPath)).toBe(true);
  }, 15_000);

  it('logs an explicit error to the data-dir log file when it gives up waiting for the lock', async () => {
    const relauncherPath = copySrcToWeirdPath();
    const dataDir = freshDir('harmonic-relauncher-locked-');
    writeDaemon(dataDir, { pid: process.pid, port: 4700, host: '127.0.0.1', startedAt: Date.now() });

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', relauncherPath, dataDir, '/unused/cli.js', JSON.stringify([])],
      {
        stdio: 'pipe',
        env: { ...process.env, HARMONIC_RELAUNCHER_MAX_WAIT_MS: '50', HARMONIC_RELAUNCHER_POLL_MS: '10' },
      },
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    expect(exitCode).not.toBe(0);
    const log = readFileSync(logFilePath(dataDir), 'utf8');
    expect(log).toMatch(/gave up waiting/i);
    expect(log).toMatch(/not restarted/i);
  }, 15_000);
});
