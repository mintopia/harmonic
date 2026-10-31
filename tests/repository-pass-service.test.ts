import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAsyncDb } from '../src/db/async.js';
import { loadSecretKey } from '../src/secrets/secret-key.js';
import { GlobalSecretService } from '../src/secrets/global-secret-service.js';
import { RepositoryPassService, PASS_LIFETIME_MS } from '../src/repository-proxy/pass-service.js';
import { verifyPass } from '../src/repository-proxy/pass.js';
import { createRepositoryProxy, repositoryPath } from '../src/repository-proxy/server.js';

const run = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_TERMINAL_PROMPT: '0',
};
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, env: GIT_ENV })).stdout;
const fails = async (cwd: string, ...args: string[]) => {
  try {
    await git(cwd, ...args);
    return false;
  } catch {
    return true;
  }
};

describe('RepositoryPassService', () => {
  let root: string;
  let upstream: string;
  let service: RepositoryPassService;
  let proxy: Server | undefined;
  let proxyKey = '';
  let origin = '';
  let now = Date.now();

  const spec = () => ({ codeRepository: upstream, baseBranch: 'main', ticketBranch: 'harmonic/task-1' });
  const fetchWith = (token: string) =>
    fails(join(root, 'work'), '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'fetch', 'origin', 'main', 'harmonic/task-1');

  const startProxy = async (key: string) => {
    await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
    proxyKey = key;
    proxy = createRepositoryProxy({ key, now: () => now });
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    await git(join(root, 'work'), 'remote', 'set-url', 'origin', `${origin}${repositoryPath(upstream)}`);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'repo-pass-service-'));
    upstream = join(root, 'upstream.git');
    const seed = join(root, 'seed');
    await git(root, 'init', '--bare', '-b', 'main', upstream);
    await git(root, 'init', '-b', 'main', seed);
    writeFileSync(join(seed, 'a.txt'), 'a');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'base');
    await git(seed, 'branch', 'harmonic/task-1');
    await git(seed, 'push', upstream, 'main', 'harmonic/task-1');
    await git(root, 'init', '-b', 'main', join(root, 'work'));
    await git(join(root, 'work'), 'remote', 'add', 'origin', upstream);
    const db = await openAsyncDb(root);
    service = new RepositoryPassService(new GlobalSecretService(db, loadSecretKey(root, {})), () => now);
  });

  afterAll(() => {
    proxy?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses to issue a pass until a signing key exists', async () => {
    await expect(service.issue('k8s-prod', spec())).rejects.toThrow(/no signing key/);
  });

  it('issues a 24 h pass the proxy accepts for git fetch', async () => {
    const { key } = await service.rotate('k8s-prod');
    await startProxy(key);
    const token = await service.issue('k8s-prod', spec());
    const verdict = verifyPass(token, key, now);
    expect(verdict.ok && verdict.pass.expiresAt).toBe(now + PASS_LIFETIME_MS);
    expect(await fetchWith(token)).toBe(false);
  });

  it('rejects the old pass after rotation, and a new pass works once the proxy has the new key', async () => {
    const oldToken = await service.issue('k8s-prod', spec());
    const rotated = await service.rotate('k8s-prod');
    expect(rotated.key).not.toBe(proxyKey);

    const newToken = await service.issue('k8s-prod', spec());
    expect(await fetchWith(newToken)).toBe(true);

    await startProxy(rotated.key);
    expect(await fetchWith(oldToken)).toBe(true);
    expect(await fetchWith(newToken)).toBe(false);
      });

  it('reports whether the proxy accepts Harmonic\'s key', async () => {
    const url = () => origin;
    await startProxy((await service.rotate('k8s-prod')).key);
    expect(await service.checkProxy('k8s-prod', url())).toBe('agrees');
    await service.rotate('k8s-prod');
    expect(await service.checkProxy('k8s-prod', url())).toBe('rejected');
    expect(await service.checkProxy('k8s-prod', 'http://127.0.0.1:1')).toBe('unreachable');
  });
});
