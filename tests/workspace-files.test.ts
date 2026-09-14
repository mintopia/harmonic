import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaces } from '../src/db/schema.js';
import { startServer, type TestServer } from './helpers.js';

describe('workspace Files API (issue #584)', () => {
  let server: TestServer;
  let root: string;

  beforeAll(async () => {
    server = await startServer();
    root = mkdtempSync(join(tmpdir(), 'harmonic-files-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'README.md'), '# Harmonic\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0xff]));
    writeFileSync(join(root, '.env'), 'SECRET=nope\n');
    await server.app.ctx.asyncDb.write((db) => db.update(workspaces).set({ workingDir: root }).run());
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await server.close();
  });

  it('lists files and directories, pages entries, and expands a directory lazily', async () => {
    const first = await server.api('GET', '/api/fs/tree?workspaceId=1&limit=2');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ path: '', total: 5, limit: 2, offset: 0 });
    expect(first.body.entries).toEqual([
      { name: 'empty', path: 'empty', type: 'directory', size: expect.any(Number) },
      { name: 'src', path: 'src', type: 'directory', size: expect.any(Number) },
    ]);

    const nested = await server.api('GET', '/api/fs/tree?workspaceId=1&path=src');
    expect(nested.status).toBe(200);
    expect(nested.body.entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', type: 'file', size: 26 }]);
  });

  it('reads text files with metadata and identifies binary files', async () => {
    const text = await server.api('GET', '/api/fs/file?workspaceId=1&path=src/index.ts');
    expect(text.status).toBe(200);
    expect(text.body).toEqual({ text: 'export const answer = 42;\n', mime: 'text/typescript', size: 26, isBinary: false });

    const binary = await server.api('GET', '/api/fs/file?workspaceId=1&path=binary.dat');
    expect(binary.status).toBe(200);
    expect(binary.body).toEqual({ text: null, mime: 'application/octet-stream', size: 1, isBinary: true });
  });

  it('confines paths to the workspace, including symlink escapes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'harmonic-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'escape'));

    const traversal = await server.api('GET', '/api/fs/file?workspaceId=1&path=../secret.txt');
    const absolute = await server.api('GET', `/api/fs/file?workspaceId=1&path=${encodeURIComponent(join(outside, 'secret.txt'))}`);
    const symlink = await server.api('GET', '/api/fs/file?workspaceId=1&path=escape/secret.txt');
    expect([traversal.status, absolute.status, symlink.status]).toEqual([400, 400, 400]);

    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects directories when reading a file', async () => {
    const response = await server.api('GET', '/api/fs/file?workspaceId=1&path=src');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation');
  });
});
