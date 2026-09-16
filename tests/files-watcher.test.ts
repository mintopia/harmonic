import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectFirehose, startServer, waitFor, type TestServer } from './helpers.js';

type GitStatusEntry = { path: string; indexStatus?: string; worktreeStatus?: string };

describe('workspace filesystem watcher (issue #590)', () => {
  let server: TestServer;
  let root: string;

  beforeAll(async () => {
    server = await startServer({ fileWatcherDebounceMs: 25 });
    root = mkdtempSync(join(tmpdir(), 'harmonic-watcher-'));
    mkdirSync(join(root, 'ignored'));
    execFileSync('git', ['init', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
    writeFileSync(join(root, 'tracked.txt'), 'initial\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'initial']);
    const response = await server.api('PATCH', '/api/workspaces/1', { workingDir: root, excludedDirectories: ['ignored', '.git'] });
    expect(response.status).toBe(200);
  });

  afterAll(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('coalesces visible changes, skips excluded directories, and pushes fresh git status', async () => {
    const client = await connectFirehose(server);
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');
    writeFileSync(join(root, 'ignored', 'hidden.txt'), 'hidden\n');
    await waitFor(async () => client.messages.some((message) => message.type === 'fs_changed' && message.workspaceId === 1));
    const status = await waitFor(async () => {
      const s = client.messages.findLast((message) => message.type === 'git_status' && message.workspaceId === 1);
      return s
        && s.entries.some((e: GitStatusEntry) => e.path === 'tracked.txt' && e.worktreeStatus === 'M')
        && s.entries.some((e: GitStatusEntry) => e.path === 'new.txt' && e.indexStatus === '?')
        ? s : undefined;
    });
    const fsChanges = client.messages.filter((message) => message.type === 'fs_changed' && message.workspaceId === 1);
    expect(fsChanges).toHaveLength(1);
    expect(status.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', worktreeStatus: 'M' }),
      expect.objectContaining({ path: 'new.txt', indexStatus: '?' }),
    ]));
    expect(client.messages.some((message) => message.type === 'fs_changed' && message.path?.includes('ignored'))).toBe(false);
    client.close();
  });

  it('recomputes status when the Git index changes even though .git is excluded', async () => {
    const client = await connectFirehose(server);
    execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
    const status = await waitFor(async () => {
      const s = client.messages.findLast((message) => message.type === 'git_status' && message.workspaceId === 1);
      return s && s.entries.some((e: GitStatusEntry) => e.path === 'tracked.txt' && e.indexStatus === 'M') ? s : undefined;
    });
    expect(status.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tracked.txt', indexStatus: 'M' })]));
    client.close();
  });
});
