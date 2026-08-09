import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { startServer, type TestServer } from './helpers.js';

/**
 * GET /api/fs — the lazy, one-level directory browser behind the workspace
 * directory picker (issue #62). Returns immediate child directories of a path,
 * defaulting to the server user's home; hidden dirs excluded; files omitted.
 */
describe('GET /api/fs (issue #62)', () => {
  let server: TestServer;
  let root: string;

  beforeAll(async () => {
    server = await startServer();
    // A scratch tree: two visible dirs, one hidden dir, one file.
    root = mkdtempSync(join(tmpdir(), 'harmonic-fs-'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'a-file.txt'), 'x');
  });
  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await server.close();
  });

  it('lists immediate child directories of a valid path, sorted, files and hidden dirs excluded', async () => {
    const { status, body } = await server.api('GET', `/api/fs?path=${encodeURIComponent(root)}`);
    expect(status).toBe(200);
    expect(body.path).toBe(root);
    expect(body.parent).toBe(dirname(root));
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['alpha', 'beta']);
    expect(body.entries.map((e: { path: string }) => e.path)).toEqual([
      join(root, 'alpha'),
      join(root, 'beta'),
    ]);
  });

  it('defaults to the server user home when path is empty or omitted', async () => {
    const omitted = await server.api('GET', '/api/fs');
    expect(omitted.status).toBe(200);
    expect(omitted.body.path).toBe(homedir());

    const empty = await server.api('GET', '/api/fs?path=');
    expect(empty.status).toBe(200);
    expect(empty.body.path).toBe(homedir());
  });

  it('is one level only — grandchildren are not returned', async () => {
    mkdirSync(join(root, 'alpha', 'nested'));
    const { body } = await server.api('GET', `/api/fs?path=${encodeURIComponent(root)}`);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('alpha');
    expect(names).not.toContain('nested');
  });

  it('root of the filesystem reports a null parent', async () => {
    const { status, body } = await server.api('GET', '/api/fs?path=/');
    expect(status).toBe(200);
    expect(body.path).toBe('/');
    expect(body.parent).toBeNull();
  });

  it('404s a path that does not exist', async () => {
    const { status, body } = await server.api(
      'GET',
      `/api/fs?path=${encodeURIComponent(join(root, 'nope'))}`,
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('400s a path that is a file, not a directory', async () => {
    const { status, body } = await server.api(
      'GET',
      `/api/fs?path=${encodeURIComponent(join(root, 'a-file.txt'))}`,
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('validation');
  });

  it('follows a symlink that points at a directory, and drops a dangling one', async () => {
    symlinkSync(join(root, 'beta'), join(root, 'link-to-beta'));
    symlinkSync(join(root, 'a-file.txt'), join(root, 'link-to-file'));
    symlinkSync(join(root, 'gone'), join(root, 'link-dangling'));
    const { body } = await server.api('GET', `/api/fs?path=${encodeURIComponent(root)}`);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('link-to-beta');
    expect(names).not.toContain('link-to-file'); // symlink to a file, not a dir
    expect(names).not.toContain('link-dangling'); // broken symlink
  });

  it('requires authentication (not reachable anonymously)', async () => {
    const { status } = await server.anonApi('GET', '/api/fs');
    expect(status).toBe(401);
  });

  it('is operator-only — a read-scoped key is forbidden', async () => {
    const readToken = (await server.api('POST', '/api/keys', { name: 'viz', scope: 'read' })).body.token;
    const res = await fetch(`${server.baseUrl}/api/fs`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(403);
  });
});
