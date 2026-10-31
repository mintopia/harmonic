import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signPass, type RepositoryPass } from '../src/repository-proxy/pass.js';
import { createRepositoryProxy, repositoryPath } from '../src/repository-proxy/server.js';

const run = promisify(execFile);
const KEY = 'test-signing-key';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, env: GIT_ENV })).stdout;
}

async function gitFails(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await git(cwd, ...args);
    return false;
  } catch {
    return true;
  }
}

describe('Repository Proxy', () => {
  let root: string;
  let upstream: string;
  let server: Server;
  let origin: string;
  let work: string;
  let now = Date.now();
  const upstreamRefs = () => git(upstream, 'for-each-ref', '--format=%(refname) %(objectname)');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'repo-proxy-'));
    upstream = join(root, 'upstream.git');
    const seed = join(root, 'seed');
    await git(root, 'init', '--bare', '-b', 'main', upstream);
    await git(root, 'init', '-b', 'main', seed);
    writeFileSync(join(seed, 'a.txt'), 'a');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'base');
    await git(seed, 'push', upstream, 'main');
    await git(seed, 'branch', 'harmonic/task-1');
    await git(seed, 'checkout', '-b', 'harmonic/task-2');
    writeFileSync(join(seed, 'two.txt'), 'two');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'task two');
    await git(seed, 'checkout', 'main');
    await git(seed, 'push', upstream, 'harmonic/task-1', 'harmonic/task-2');
    await git(seed, 'tag', 'v1');
    await git(seed, 'push', upstream, 'v1');
    server = createRepositoryProxy({ key: KEY, now: () => now });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const passFor = (over: Partial<RepositoryPass> = {}) =>
    signPass(
      {
        codeRepository: upstream,
        baseBranch: 'main',
        ticketBranch: 'harmonic/task-1',
        expiresAt: now + 60_000,
        ...over,
      },
      KEY,
    );

  const remoteUrl = () => `${origin}${repositoryPath(upstream)}`;
  const gitWith = (token: string, cwd: string, ...args: string[]) =>
    git(cwd, '-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args);

  beforeEach(async () => {
    now = Date.now();
    work = join(root, `work-${Math.random().toString(36).slice(2)}`);
    await git(root, 'init', '-b', 'main', work);
    await git(work, 'remote', 'add', 'origin', remoteUrl());
    await gitWith(passFor(), work, 'fetch', 'origin', 'main', 'harmonic/task-1');
    await git(work, 'checkout', '-b', 'harmonic/task-1', 'FETCH_HEAD');
    writeFileSync(join(work, 'b.txt'), 'b');
    await git(work, 'add', '.');
    await git(work, 'commit', '-m', 'work');
  });

  it('fetches the base and Ticket branches, and pushes then force-pushes the Ticket branch', async () => {
    const token = passFor();
    await gitWith(token, work, 'push', 'origin', 'harmonic/task-1');
    expect(await upstreamRefs()).toContain(`refs/heads/harmonic/task-1 ${(await git(work, 'rev-parse', 'HEAD')).trim()}`);

    await git(work, 'commit', '--amend', '-m', 'rewritten');
    await gitWith(token, work, 'push', '--force', 'origin', 'harmonic/task-1');
    expect(await upstreamRefs()).toContain(`refs/heads/harmonic/task-1 ${(await git(work, 'rev-parse', 'HEAD')).trim()}`);
  });

  it('refuses pushing another branch, a tag or a delete and leaves upstream refs unchanged', async () => {
    const token = passFor();
    const before = await upstreamRefs();
    await git(work, 'tag', 'v2');
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', 'origin', 'harmonic/task-1:other')).toBe(true);
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', 'origin', 'harmonic/task-1:harmonic/task-2')).toBe(true);
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', 'origin', 'v2')).toBe(true);
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', 'origin', '--delete', 'harmonic/task-1')).toBe(true);
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'push', 'origin', '--delete', 'main')).toBe(true);
    expect(await upstreamRefs()).toBe(before);
  });

  it('refuses fetching another Ticket branch, a tag or a raw object', async () => {
    const token = passFor();
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'fetch', 'origin', 'harmonic/task-2')).toBe(true);
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'fetch', 'origin', 'refs/tags/v1')).toBe(true);
    const tip = (await git(upstream, 'rev-parse', 'harmonic/task-2')).trim();
    const line = `want ${tip} no-progress\n`;
    const pkt = `${(line.length + 4).toString(16).padStart(4, '0')}${line}00000009done\n`;
    const res = await fetch(`${remoteUrl()}/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-git-upload-pack-request' },
      body: pkt,
    });
    expect(res.status).toBe(403);
    expect((await git(upstream, 'rev-parse', 'harmonic/task-2')).trim()).toBe(tip);
  });

  it('rejects an expired pass, a tampered signature and a wrong repository', async () => {
    const expired = passFor({ expiresAt: now - 1 });
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${expired}`, 'fetch', 'origin', 'main')).toBe(true);

    const [body, sig] = passFor().split('.') as [string, string];
    const tamperedBody = Buffer.from(JSON.stringify({
      codeRepository: upstream,
      baseBranch: 'main',
      ticketBranch: 'harmonic/task-2',
      expiresAt: now + 60_000,
    })).toString('base64url');
    expect(body).not.toBe(tamperedBody);
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${tamperedBody}.${sig}`, 'fetch', 'origin', 'main')).toBe(true);

    const other = signPass(
      { codeRepository: join(root, 'other.git'), baseBranch: 'main', ticketBranch: 'harmonic/task-1', expiresAt: now + 60_000 },
      KEY,
    );
    expect(await gitFails(work, '-c', `http.extraHeader=Authorization: Bearer ${other}`, 'fetch', 'origin', 'main')).toBe(true);
  });

  it('refuses forge API paths, even with a valid pass', async () => {
    for (const path of ['/api/v3/repos/o/r/pulls', '/api/v1/repos/o/r/branches', `${repositoryPath(upstream)}/pulls`]) {
      const res = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${passFor()}` } });
      expect(res.status).toBe(403);
    }
  });
});
