import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initdScript } from '../src/service-manager.js';
import { createTempDirTracker } from './helpers/upgrade-fixture.js';

const { tempDir, cleanupAll } = createTempDirTracker();
afterEach(cleanupAll);

const guardSource = readFileSync(fileURLToPath(new URL('../src/upgrade/boot-guard.cjs', import.meta.url)), 'utf8');

const fakeCliJs = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cmd = args[0];
const dataDir = args[args.indexOf('--data-dir') + 1];
const pidFile = path.join(dataDir, 'harmonic.pid');
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
let info = null;
try { info = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch {}
const running = Boolean(info && isAlive(info.pid));
if (cmd === 'status') process.exit(running ? 0 : 1);
if (cmd === 'start') {
  if (running) process.exit(1);
  fs.writeFileSync(path.join(dataDir, 'started-marker'), '1');
  process.exit(0);
}
process.exit(1);
`;

/** `runuser -u <user> -- <cmd...>` stub: this container has no real runuser/setuid path, so exec the command as-is. */
const runuserStub = `#!/bin/sh
shift 3
exec "$@"
`;

function setupInitdFixture(): { dataDir: string; appDir: string; scriptPath: string; env: NodeJS.ProcessEnv } {
  const dataDir = tempDir('initd-start-datadir-');
  const appDir = join(dataDir, 'app');
  mkdirSync(join(appDir, 'versions', '2.0.0', 'dist'), { recursive: true });
  mkdirSync(join(appDir, 'versions', '1.0.0', 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'versions', '2.0.0', 'dist', 'cli.js'), fakeCliJs);
  symlinkSync('versions/2.0.0', join(appDir, 'current'));
  writeFileSync(join(appDir, 'boot-guard.cjs'), guardSource);
  writeFileSync(
    join(appDir, 'pending.json'),
    JSON.stringify({ version: '2.0.0', previous: '1.0.0', snapshot: join(appDir, 'pre-2.0.0.db'), boots: 3 }),
  );

  const binDir = tempDir('initd-start-bin-');
  writeFileSync(join(binDir, 'id'), '#!/bin/sh\necho 0\n');
  writeFileSync(join(binDir, 'runuser'), runuserStub);
  chmodSync(join(binDir, 'id'), 0o755);
  chmodSync(join(binDir, 'runuser'), 0o755);

  const script = initdScript({ dataDir, user: 'workspace', nodePath: process.execPath });
  const scriptPath = join(tempDir('initd-start-script-'), 'harmonic');
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);

  return { dataDir, appDir, scriptPath, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } };
}

describe('init.d start script', () => {
  it('does not run the boot guard when Harmonic is already running', () => {
    const { dataDir, appDir, scriptPath, env } = setupInitdFixture();
    const liveProcess = spawn('sleep', ['30']);
    writeFileSync(
      join(dataDir, 'harmonic.pid'),
      JSON.stringify({ pid: liveProcess.pid, port: 4700, host: '0.0.0.0', startedAt: Date.now() }),
    );

    try {
      const result = spawnSync('sh', [scriptPath, 'start'], { env, encoding: 'utf8' });

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(appDir, 'pending.json'), 'utf8'))).toMatchObject({ boots: 3 });
      expect(readlinkSync(join(appDir, 'current'))).toBe('versions/2.0.0');
    } finally {
      liveProcess.kill();
    }
  });
});
