import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createClient } from '@libsql/client';
import { openAsyncDb } from '../src/db/async.js';
import { loadSecretKey, SECRET_KEY_FILE, SECRET_KEY_ENV } from '../src/secrets/secret-key.js';
import { SecretService } from '../src/secrets/secret-service.js';
import { seedWorkspace, startServer, type TestServer } from './helpers.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-secrets-'));
  dirs.push(dir);
  return dir;
};
let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('instance secret key', () => {
  it('creates a 0600 key file on first use and reuses it', () => {
    const dir = tempDir();
    const first = loadSecretKey(dir, {});
    const path = join(dir, SECRET_KEY_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(first).toHaveLength(32);
    expect(loadSecretKey(dir, {}).equals(first)).toBe(true);
  });

  it.each(['EPERM', 'ENOTSUP', 'EXDEV'])('falls back to an exclusive 0600 write when hard links fail with %s', (code) => {
    const dir = tempDir();
    const noLinks = () => {
      throw Object.assign(new Error('link unsupported'), { code });
    };
    const key = loadSecretKey(dir, {}, noLinks);
    const path = join(dir, SECRET_KEY_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(key).toHaveLength(32);
    expect(readdirSync(dir)).toEqual([SECRET_KEY_FILE]);
    expect(loadSecretKey(dir, {}, noLinks).equals(key)).toBe(true);
  });

  it('rethrows other link failures and leaves no temp file', () => {
    const dir = tempDir();
    const broken = () => {
      throw Object.assign(new Error('disk'), { code: 'EIO' });
    };
    expect(() => loadSecretKey(dir, {}, broken)).toThrow('disk');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('uses HARMONIC_SECRET_KEY without a key file, and prefers it over an existing one', () => {
    const dir = tempDir();
    const envKey = randomBytes(32);
    const env = { [SECRET_KEY_ENV]: envKey.toString('hex') };
    expect(loadSecretKey(dir, env).equals(envKey)).toBe(true);
    expect(() => statSync(join(dir, SECRET_KEY_FILE))).toThrow();
    writeFileSync(join(dir, SECRET_KEY_FILE), randomBytes(32).toString('hex'));
    expect(loadSecretKey(dir, { [SECRET_KEY_ENV]: envKey.toString('base64') }).equals(envKey)).toBe(true);
  });

  it('re-chmods a pre-existing group/world-readable key file to 0600 and keeps its key', () => {
    const dir = tempDir();
    const path = join(dir, SECRET_KEY_FILE);
    const key = randomBytes(32);
    writeFileSync(path, `${key.toString('hex')}\n`);
    chmodSync(path, 0o644);
    expect(loadSecretKey(dir, {}).equals(key)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is race-safe: concurrent first boots in separate processes agree on one non-empty key', async () => {
    const dir = tempDir();
    const script = `import { loadSecretKey } from ${JSON.stringify(new URL('../src/secrets/secret-key.ts', import.meta.url).href)};
      process.stdout.write(loadSecretKey(process.argv[1], {}).toString('hex'));`;
    const run = () => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], (err, out) =>
        err ? reject(err) : resolve(out));
    });
    const keys = await Promise.all(Array.from({ length: 6 }, run));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toHaveLength(64);
    expect(readFileSync(join(dir, SECRET_KEY_FILE), 'utf8').trim()).toBe(keys[0]);
    expect(readdirSync(dir)).toEqual([SECRET_KEY_FILE]);
  }, 60_000);

  it('rejects a key of the wrong length', () => {
    expect(() => loadSecretKey(tempDir(), { [SECRET_KEY_ENV]: 'short' })).toThrow(/32-byte/);
  });
});

describe('SecretService', () => {
  it('round-trips, replaces and clears, and stores no plaintext in the database file', async () => {
    const dir = tempDir();
    const db = await openAsyncDb(dir);
    const workspaceId = await seedWorkspace(db, dir);
    const service = new SecretService(db, loadSecretKey(dir, {}));
    const value = 'plaintext-needle-7f3a9c';

    expect(await service.has(workspaceId, 'token')).toBe(false);
    await service.set(workspaceId, 'token', value);
    expect(await service.has(workspaceId, 'token')).toBe(true);
    expect(await service.reveal(workspaceId, 'token')).toBe(value);

    await service.set(workspaceId, 'token', 'replacement-value');
    expect(await service.reveal(workspaceId, 'token')).toBe('replacement-value');
    await service.set(workspaceId, 'token', value);

    const sqlite = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    const row = (await sqlite.execute('select * from secrets')).rows[0]!;
    expect(JSON.stringify(row)).not.toContain(value);
    sqlite.close();
    expect(readFileSync(join(dir, 'harmonic.db')).includes(value)).toBe(false);

    await service.clear(workspaceId, 'token');
    expect(await service.has(workspaceId, 'token')).toBe(false);
    expect(await service.reveal(workspaceId, 'token')).toBeNull();
    await db.close();
  });

  it('refuses to decrypt under a different key or a swapped row', async () => {
    const dir = tempDir();
    const db = await openAsyncDb(dir);
    const workspaceId = await seedWorkspace(db, dir);
    const service = new SecretService(db, randomBytes(32));
    await service.set(workspaceId, 'a', 'one');
    await expect(new SecretService(db, randomBytes(32)).reveal(workspaceId, 'a')).rejects.toThrow(/cannot be decrypted/);

    const sqlite = createClient({ url: `file:${join(dir, 'harmonic.db')}` });
    await sqlite.execute("update secrets set name = 'b' where name = 'a'");
    sqlite.close();
    await expect(service.reveal(workspaceId, 'b')).rejects.toThrow(/cannot be decrypted/);
    await db.close();
  });
});

describe('Secrets routes', () => {
  it('report set / not set and never return the value', async () => {
    server = await startServer();
    const workspaceId = await seedWorkspace(server.app.ctx.asyncDb);
    const base = `/api/workspaces/${workspaceId}/secrets`;
    const value = 'route-needle-91d2';

    expect((await server.api('GET', `${base}/forgejo-token`)).body).toEqual({ name: 'forgejo-token', set: false });
    expect((await server.api('PUT', `${base}/forgejo-token`, { value })).status).toBe(200);

    const one = await server.api('GET', `${base}/forgejo-token`);
    expect(one.body).toEqual({ name: 'forgejo-token', set: true });
    const list = await server.api('GET', base);
    expect(list.body.secrets).toEqual([expect.objectContaining({ name: 'forgejo-token', set: true })]);
    expect(JSON.stringify([one.body, list.body])).not.toContain(value);
    expect(Object.keys(list.body.secrets[0]).sort()).toEqual(['name', 'set', 'updatedAt']);

    expect((await server.api('DELETE', `${base}/forgejo-token`)).status).toBe(200);
    expect((await server.api('GET', `${base}/forgejo-token`)).body.set).toBe(false);
  });

  it('404 for an unknown Workspace, 400 for a bad name or empty value, 401 without credentials', async () => {
    server = await startServer();
    const workspaceId = await seedWorkspace(server.app.ctx.asyncDb);
    expect((await server.api('PUT', '/api/workspaces/99999/secrets/x', { value: 'v' })).status).toBe(404);
    expect((await server.api('PUT', `/api/workspaces/${workspaceId}/secrets/bad%20name`, { value: 'v' })).status).toBe(400);
    expect((await server.api('PUT', `/api/workspaces/${workspaceId}/secrets/x`, { value: '' })).status).toBe(400);
    expect((await server.anonApi('GET', `/api/workspaces/${workspaceId}/secrets`)).status).toBe(401);
  });

  it('are removed when the Workspace is deleted', async () => {
    server = await startServer();
    const workspaceId = await seedWorkspace(server.app.ctx.asyncDb);
    await server.app.ctx.secrets.set(workspaceId, 'x', 'v');
    await server.app.ctx.workspaces.delete(workspaceId);
    expect(await server.app.ctx.secrets.list(workspaceId)).toEqual([]);
  });
});
