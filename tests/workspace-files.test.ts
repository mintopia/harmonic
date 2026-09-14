import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaces } from '../src/db/schema.js';
import { logger } from '../src/logger.js';
import { startServer, type TestServer } from './helpers.js';

describe('workspace Files API (issue #584)', () => {
  let server: TestServer;
  let root: string;

  beforeAll(async () => {
    server = await startServer();
    root = mkdtempSync(join(tmpdir(), 'harmonic-files-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'node_modules', 'package'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'README.md'), '# Harmonic\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0xff]));
    writeFileSync(join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, 'sound.mp3'), Buffer.from([0x49, 0x44, 0x33]));
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(2_097_153));
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
    expect(first.body).toMatchObject({ path: '', total: 11, limit: 2, offset: 0 });
    expect(first.body.entries).toEqual([
      { name: '.git', path: '.git', type: 'directory', size: expect.any(Number), excluded: true },
      { name: 'dist', path: 'dist', type: 'directory', size: expect.any(Number), excluded: true },
    ]);

    const nested = await server.api('GET', '/api/fs/tree?workspaceId=1&path=src');
    expect(nested.status).toBe(200);
    expect(nested.body.entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', type: 'file', size: 26, excluded: false }]);
  });

  it('shows default excluded directories but does not descend into them', async () => {
    const listing = await server.api('GET', '/api/fs/tree?workspaceId=1');
    expect(listing.status).toBe(200);
    expect(listing.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '.git', path: '.git', type: 'directory', excluded: true }),
      expect.objectContaining({ name: 'dist', path: 'dist', type: 'directory', excluded: true }),
      expect.objectContaining({ name: 'node_modules', path: 'node_modules', type: 'directory', excluded: true }),
      expect.objectContaining({ name: 'src', path: 'src', type: 'directory', excluded: false }),
    ]));

    const excluded = await server.api('GET', '/api/fs/tree?workspaceId=1&path=node_modules');
    expect(excluded.status).toBe(200);
    expect(excluded.body).toMatchObject({ path: 'node_modules', entries: [], total: 0 });
  });

  it('uses a Workspace exclude override for an arbitrary directory', async () => {
    const update = await server.api('PATCH', '/api/workspaces/1', { excludedDirectories: ['src'] });
    expect(update.status).toBe(200);
    expect(update.body.excludedDirectories).toEqual(['src']);

    const listing = await server.api('GET', '/api/fs/tree?workspaceId=1');
    expect(listing.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'src', path: 'src', excluded: true }),
      expect.objectContaining({ name: 'node_modules', path: 'node_modules', excluded: false }),
    ]));
  });

  it('reads text files with metadata and identifies binary files', async () => {
    const text = await server.api('GET', '/api/fs/file?workspaceId=1&path=src/index.ts');
    expect(text.status).toBe(200);
    expect(text.body).toEqual({ text: 'export const answer = 42;\n', mime: 'text/typescript', size: 26, isBinary: false, isTooLarge: false });

    const binary = await server.api('GET', '/api/fs/file?workspaceId=1&path=binary.dat');
    expect(binary.status).toBe(200);
    expect(binary.body).toEqual({ text: null, mime: 'application/octet-stream', size: 1, isBinary: true, isTooLarge: false });
  });

  it('streams raw workspace bytes with an inline media type', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/api/fs/raw?workspaceId=1&path=photo.png', cookies: { harmonic_session: server.sessionToken } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const audio = await server.app.inject({ method: 'GET', url: '/api/fs/raw?workspaceId=1&path=sound.mp3', cookies: { harmonic_session: server.sessionToken } });
    expect(audio.headers['content-type']).toContain('audio/mpeg');

    const traversal = await server.app.inject({ method: 'GET', url: '/api/fs/raw?workspaceId=1&path=../secret.txt', cookies: { harmonic_session: server.sessionToken } });
    expect(traversal.statusCode).toBe(400);
  });

  it('returns metadata without loading files over the configured editor cap', async () => {
    const response = await server.api('GET', '/api/fs/file?workspaceId=1&path=large.txt');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ text: null, mime: 'text/plain', size: 2_097_153, isBinary: false, isTooLarge: true });
  });

  it('saves text files, records the write, and keeps writes in the workspace', async () => {
    const log = vi.spyOn(logger, 'info');
    const saved = await server.api('PUT', '/api/fs/file?workspaceId=1&path=src/index.ts', { text: 'export const answer = 43;\n' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ text: 'export const answer = 43;\n', mime: 'text/typescript', size: 26, isBinary: false, isTooLarge: false });
    expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(log).toHaveBeenCalledWith('workspace file written', { workspaceId: 1, path: 'src/index.ts' });

    const outside = mkdtempSync(join(tmpdir(), 'harmonic-outside-write-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'write-escape'));
    const traversal = await server.api('PUT', '/api/fs/file?workspaceId=1&path=../secret.txt', { text: 'nope' });
    const symlink = await server.api('PUT', '/api/fs/file?workspaceId=1&path=write-escape/secret.txt', { text: 'nope' });
    expect([traversal.status, symlink.status]).toEqual([400, 400]);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    rmSync(outside, { recursive: true, force: true });
    log.mockRestore();
  });

  it('reports staged, modified, and untracked paths without changing the workspace', async () => {
    execFileSync('git', ['init', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'initial']);
    writeFileSync(join(root, 'README.md'), '# Changed\n');
    writeFileSync(join(root, 'src', 'staged.ts'), 'export {};\n');
    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    execFileSync('git', ['-C', root, 'add', 'src/staged.ts']);
    const indexBefore = readFileSync(join(root, '.git', 'index'));

    const response = await server.api('GET', '/api/git/status?workspaceId=1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      entries: expect.arrayContaining([
        { path: 'README.md', indexStatus: '.', worktreeStatus: 'M' },
        { path: 'src/staged.ts', indexStatus: 'A', worktreeStatus: '.' },
        { path: 'untracked.txt', indexStatus: '?', worktreeStatus: '?' },
      ]),
    });
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(indexBefore);
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toContain(' M README.md');
  });

  it('stages, unstages, discards, and commits selected workspace paths', async () => {
    const invalidPath = await server.api('POST', '/api/git/stage', { workspaceId: 1, paths: ['../outside'] });
    expect(invalidPath.status).toBe(400);

    const literalPath = await server.api('POST', '/api/git/discard', { workspaceId: 1, paths: [':(glob)**'] });
    expect(literalPath.status).toBe(200);
    expect((await server.api('GET', '/api/git/status?workspaceId=1')).body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'untracked.txt' }),
    ]));

    const stage = await server.api('POST', '/api/git/stage', { workspaceId: 1, paths: ['README.md'] });
    expect(stage.status).toBe(200);
    expect((await server.api('GET', '/api/git/status?workspaceId=1')).body.entries).toEqual(expect.arrayContaining([
      { path: 'README.md', indexStatus: 'M', worktreeStatus: '.' },
    ]));

    const unstage = await server.api('POST', '/api/git/unstage', { workspaceId: 1, paths: ['README.md'] });
    expect(unstage.status).toBe(200);
    expect((await server.api('GET', '/api/git/status?workspaceId=1')).body.entries).toEqual(expect.arrayContaining([
      { path: 'README.md', indexStatus: '.', worktreeStatus: 'M' },
    ]));

    const discard = await server.api('POST', '/api/git/discard', { workspaceId: 1, paths: ['untracked.txt'] });
    expect(discard.status).toBe(200);
    expect((await server.api('GET', '/api/git/status?workspaceId=1')).body.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'untracked.txt' }),
    ]));

    await server.api('POST', '/api/git/stage', { workspaceId: 1, paths: ['README.md'] });
    writeFileSync(join(root, 'README.md'), '# Changed again\n');
    await server.api('POST', '/api/git/discard', { workspaceId: 1, paths: ['README.md'] });
    expect((await server.api('GET', '/api/git/status?workspaceId=1')).body.entries).toEqual(expect.arrayContaining([
      { path: 'README.md', indexStatus: 'M', worktreeStatus: '.' },
    ]));
    const commit = await server.api('POST', '/api/git/commit', { workspaceId: 1, message: 'Update readme' });
    expect(commit.status).toBe(200);
    expect((await server.api('GET', '/api/git/status?workspaceId=1')).body.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md' }),
    ]));
    expect(execFileSync('git', ['-C', root, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Update readme');
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

  it('creates files and directories, records the write, and rejects duplicates', async () => {
    const log = vi.spyOn(logger, 'info');
    const dir = await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'created', type: 'directory' });
    expect(dir.status).toBe(200);
    expect(dir.body).toMatchObject({ name: 'created', path: 'created', type: 'directory' });

    const file = await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'created/note.txt', type: 'file' });
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({ name: 'note.txt', path: 'created/note.txt', type: 'file', size: 0 });
    expect(readFileSync(join(root, 'created', 'note.txt'), 'utf8')).toBe('');
    expect(log).toHaveBeenCalledWith('workspace entry created', { workspaceId: 1, path: 'created/note.txt', type: 'file' });

    const duplicate = await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'created/note.txt', type: 'file' });
    expect(duplicate.status).toBe(400);

    const missingParent = await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'nope/deep.txt', type: 'file' });
    expect(missingParent.status).toBe(404);

    const traversal = await server.api('POST', '/api/fs/create', { workspaceId: 1, path: '../escapee.txt', type: 'file' });
    expect(traversal.status).toBe(400);
    log.mockRestore();
  });

  it('renames and moves entries, and refuses to overwrite or leave the workspace', async () => {
    await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'movable.txt', type: 'file' });
    const renamed = await server.api('POST', '/api/fs/move', { workspaceId: 1, from: 'movable.txt', to: 'created/moved.txt' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'moved.txt', path: 'created/moved.txt', type: 'file' });
    expect(readFileSync(join(root, 'created', 'moved.txt'), 'utf8')).toBe('');

    const overwrite = await server.api('POST', '/api/fs/move', { workspaceId: 1, from: 'created/moved.txt', to: 'created/note.txt' });
    expect(overwrite.status).toBe(400);

    const missing = await server.api('POST', '/api/fs/move', { workspaceId: 1, from: 'created/gone.txt', to: 'created/other.txt' });
    expect(missing.status).toBe(404);

    const escape = await server.api('POST', '/api/fs/move', { workspaceId: 1, from: 'created/moved.txt', to: '../escapee.txt' });
    expect(escape.status).toBe(400);
  });

  it('deletes files and directories recursively and confines the target', async () => {
    const log = vi.spyOn(logger, 'info');
    await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'created/inner', type: 'directory' });
    await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'created/inner/leaf.txt', type: 'file' });

    const file = await server.api('POST', '/api/fs/delete', { workspaceId: 1, path: 'created/note.txt' });
    expect(file.status).toBe(200);
    expect(log).toHaveBeenCalledWith('workspace entry deleted', { workspaceId: 1, path: 'created/note.txt' });

    const dir = await server.api('POST', '/api/fs/delete', { workspaceId: 1, path: 'created' });
    expect(dir.status).toBe(200);
    const listing = await server.api('GET', '/api/fs/tree?workspaceId=1');
    expect(listing.body.entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'created' })]));

    const traversal = await server.api('POST', '/api/fs/delete', { workspaceId: 1, path: '../secret.txt' });
    const missing = await server.api('POST', '/api/fs/delete', { workspaceId: 1, path: 'created' });
    expect([traversal.status, missing.status]).toEqual([400, 404]);
    log.mockRestore();
  });

  it('returns a unified diff for a changed path and an all-added diff for an untracked one', async () => {
    writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 100;\n');
    const changed = await server.api('GET', '/api/git/diff?workspaceId=1&path=src/index.ts');
    expect(changed.status).toBe(200);
    expect(changed.body.file).toMatchObject({ path: 'src/index.ts' });
    expect(changed.body.file.additions).toBeGreaterThan(0);

    writeFileSync(join(root, 'fresh.txt'), 'brand new line\n');
    const untracked = await server.api('GET', '/api/git/diff?workspaceId=1&path=fresh.txt');
    expect(untracked.status).toBe(200);
    expect(untracked.body.file).toMatchObject({ path: 'fresh.txt' });
    expect(untracked.body.file.additions).toBeGreaterThan(0);

    const traversal = await server.api('GET', '/api/git/diff?workspaceId=1&path=../secret.txt');
    expect(traversal.status).toBe(400);
  });

  it('rejects symlink escapes on write operations', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'harmonic-write-escape-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'link-escape'));

    const create = await server.api('POST', '/api/fs/create', { workspaceId: 1, path: 'link-escape/injected.txt', type: 'file' });
    const del = await server.api('POST', '/api/fs/delete', { workspaceId: 1, path: 'link-escape/secret.txt' });
    expect(create.status).toBe(400);
    expect(del.status).toBe(400);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');

    rmSync(join(root, 'link-escape'));
    rmSync(outside, { recursive: true, force: true });
  });
});
