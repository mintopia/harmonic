import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { startServer, TEST_PASSWORD, type TestServer } from './helpers.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway Config Repo containing harmonic.json. */
function makeConfigRepo(file: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-cfgrepo-'));
  execFileSync('git', ['init', '-b', 'main', dir]);
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'receive.denyCurrentBranch', 'ignore');
  writeFileSync(join(dir, 'harmonic.json'), JSON.stringify(file, null, 2));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'seed config');
  return dir;
}

/** Init a fresh data dir from a repo (what `harmonic init --repo` does). */
async function initDataDir(repo: string): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'harmonic-init-'));
  const app = await buildApp({ dataDir, password: TEST_PASSWORD });
  await app.ctx.configRepo.init(repo);
  await app.close();
  return dataDir;
}

const seedFile = (apiToken: string) => ({
  config: {
    harnesses: {
      claude: { command: 'node', args: ['nowhere.mjs'], models: ['seeded-model'], defaultModel: 'seeded-model' },
    },
    defaults: { harness: 'claude', workingDir: '/tmp/seeded', isolationMode: 'worktree', priority: 'high' },
    autoRunner: { enabled: false, maxConcurrentRuns: 3 },
  },
  channels: [
    { name: 'seeded-hook', type: 'webhook', config: { url: 'http://127.0.0.1:9/x' }, events: ['task.failed'] },
  ],
  apiKeys: [
    {
      name: 'seeded-key',
      tokenHash: createHash('sha256').update(apiToken).digest('hex'),
      prefix: apiToken.slice(0, 12),
    },
  ],
});

describe('config repo import / pull / export', () => {
  it('init imports harness config, defaults, channels, and api keys into a fresh instance', async () => {
    const token = 'adk_' + randomBytes(24).toString('hex');
    const repo = makeConfigRepo(seedFile(token));
    const dataDir = await initDataDir(repo);
    const server = await startServer(undefined, { dataDir });

    const config = (await server.api('GET', '/api/config')).body;
    expect(config.harnesses.claude.models).toEqual(['seeded-model']);
    expect(config.defaults.workingDir).toBe('/tmp/seeded');
    expect(config.defaults.priority).toBe('high');
    expect(config.autoRunner.maxConcurrentRuns).toBe(3);

    const channels = (await server.api('GET', '/api/channels')).body.channels;
    expect(channels.map((c: any) => c.name)).toContain('seeded-hook');

    // The imported key's owner can use their token immediately.
    const viaKey = await fetch(`${server.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaKey.status).toBe(200);

    await server.close();
  });

  it('does not sync in the background; an explicit pull re-imports', async () => {
    const token = 'adk_' + randomBytes(24).toString('hex');
    const repo = makeConfigRepo(seedFile(token));
    const dataDir = await initDataDir(repo);
    const server = await startServer(undefined, { dataDir });

    // Live change after import: stays until an explicit pull.
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentRuns: 7 } });

    // The repo moves on.
    const updated = seedFile(token);
    updated.config.autoRunner.maxConcurrentRuns = 5;
    writeFileSync(join(repo, 'harmonic.json'), JSON.stringify(updated, null, 2));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'bump concurrency');

    // Nothing synced by itself.
    expect((await server.api('GET', '/api/config')).body.autoRunner.maxConcurrentRuns).toBe(7);

    const pulled = await server.api('POST', '/api/config-repo/pull');
    expect(pulled.status).toBe(200);
    expect((await server.api('GET', '/api/config')).body.autoRunner.maxConcurrentRuns).toBe(5);

    await server.close();
  });

  it('a pull of a partial file seeds what it declares and leaves the rest of live config alone', async () => {
    const token = 'adk_' + randomBytes(24).toString('hex');
    const repo = makeConfigRepo(seedFile(token));
    const dataDir = await initDataDir(repo);
    const server = await startServer(undefined, { dataDir });

    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentRuns: 7 } });

    // The repo now declares only a default priority — nothing else.
    writeFileSync(
      join(repo, 'harmonic.json'),
      JSON.stringify({ config: { defaults: { priority: 'low' } } }, null, 2),
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'partial config');

    await server.api('POST', '/api/config-repo/pull');
    const config = (await server.api('GET', '/api/config')).body;
    expect(config.defaults.priority).toBe('low');
    expect(config.autoRunner.maxConcurrentRuns).toBe(7);
    expect(config.harnesses.claude.models).toEqual(['seeded-model']);

    await server.close();
  });

  it('export writes a committable file that round-trips through import faithfully', async () => {
    const token = 'adk_' + randomBytes(24).toString('hex');
    const repo = makeConfigRepo(seedFile(token));
    const dataDir = await initDataDir(repo);
    const server = await startServer(undefined, { dataDir });

    // Mutate live state so the export differs from the seed.
    await server.api('PATCH', '/api/config', { autoRunner: { maxConcurrentRuns: 9 } });
    await server.api('POST', '/api/channels', {
      name: 'added-later',
      type: 'slack',
      config: { url: 'http://127.0.0.1:9/slack' },
    });

    const exported = await server.api('POST', '/api/config-repo/export');
    expect(exported.status).toBe(200);
    const file = JSON.parse(readFileSync(exported.body.path, 'utf8'));
    expect(file.config.autoRunner.maxConcurrentRuns).toBe(9);
    expect(file.channels.map((c: any) => c.name)).toContain('added-later');
    // The export landed inside the clone — committable.
    expect(exported.body.path).toContain(join(dataDir, 'config-repo'));

    // Round-trip: commit the export in the clone, init a fresh instance from it.
    const clone = join(dataDir, 'config-repo');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'export');
    const freshDataDir = await initDataDir(clone);
    const fresh = await startServer(undefined, { dataDir: freshDataDir });

    const freshConfig = (await fresh.api('GET', '/api/config')).body;
    expect(freshConfig).toEqual((await server.api('GET', '/api/config')).body);
    const freshChannels = (await fresh.api('GET', '/api/channels')).body.channels;
    expect(freshChannels.map((c: any) => c.name).sort()).toEqual(['added-later', 'seeded-hook']);
    // The seeded key still works on the fresh instance.
    const viaKey = await fetch(`${fresh.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaKey.status).toBe(200);

    await fresh.close();
    await server.close();
    rmSync(freshDataDir, { recursive: true, force: true });
  });
});
