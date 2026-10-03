import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRepositoryResolver } from '../src/repository/resolve.js';
import { workspaceTrackerSettings } from '../src/tracker/adapter.js';
import { seedWorkspace, startServer, type TestServer } from './helpers.js';

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

const dirs: string[] = [];
let server: TestServer | undefined;
let seen: Seen[] = [];

function stubForge(reply: (url: string, auth: string | null) => Response): void {
  seen = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url))) return realFetch(url, init);
    const headers = new Headers(init?.headers);
    const record: Seen = {
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(record);
    return reply(url, record.authorization);
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function workspaceWith(patch: Record<string, unknown>, origin?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-secrets-resolution-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  server = await startServer();
  const id = await seedWorkspace(server.app.ctx.asyncDb);
  await server.app.ctx.workspaces.update(id, { workingDir: dir, ...patch });
  return { s: server, id };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const forgejoTracker = { kind: 'forgejo', settings: { baseUrl: 'https://forge.test', repo: 'o/r' } };

describe('tracker Secrets reach the adapter at runtime', () => {
  it('a stored FORGEJO_TOKEN authenticates the Forgejo tracker', async () => {
    stubForge((_url, auth) => (auth === 'token tok-123' ? json({ login: 'harmonic-bot' }) : json({}, 401)));
    const { s, id } = await workspaceWith({ configuredTracker: forgejoTracker });
    await s.app.ctx.secrets.set(id, 'FORGEJO_TOKEN', 'tok-123');

    const { body } = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);

    expect(body).toEqual({ ok: true, identity: 'harmonic-bot' });
    expect(seen).toEqual([expect.objectContaining({ url: 'https://forge.test/api/v1/user', authorization: 'token tok-123' })]);
  });

  it('a custom Jira secretName is revealed and sent as Basic auth', async () => {
    stubForge(() => json({ accountId: 'acc-1', displayName: 'J Smith' }));
    const configuredTracker = {
      kind: 'jira',
      settings: { baseUrl: 'https://acme.atlassian.net', authMode: 'cloud', email: 'me@acme.test', projectKey: 'PROJ', secretName: 'MY_JIRA' },
    };
    const { s, id } = await workspaceWith({ configuredTracker });
    await s.app.ctx.secrets.set(id, 'MY_JIRA', 'jira-tok');

    const { body } = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);

    expect(body).toEqual({ ok: true, identity: 'J Smith' });
    expect(seen[0]).toMatchObject({
      url: 'https://acme.atlassian.net/rest/api/2/myself',
      authorization: `Basic ${Buffer.from('me@acme.test:jira-tok').toString('base64')}`,
    });
  });

  it('a Jira Workspace with no secretName reads the default JIRA_TOKEN Secret', async () => {
    stubForge(() => json({ name: 'jsmith' }));
    const configuredTracker = { kind: 'jira', settings: { baseUrl: 'https://jira.acme.test', authMode: 'datacenter', projectKey: 'PROJ' } };
    const { s, id } = await workspaceWith({ configuredTracker });
    await s.app.ctx.secrets.set(id, 'JIRA_TOKEN', 'dc-pat');

    const { body } = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);

    expect(body).toEqual({ ok: true, identity: 'jsmith' });
    expect(seen[0]!.authorization).toBe('Bearer dc-pat');
  });

  it('names the missing Secret, never a value, when none is stored', async () => {
    stubForge(() => json({}));
    const { s, id } = await workspaceWith({ configuredTracker: forgejoTracker });

    const { body } = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);

    expect(body).toMatchObject({ ok: false, reason: expect.stringContaining('"FORGEJO_TOKEN" Secret') });
    expect(seen).toEqual([]);
  });

  it('never returns a Secret echoed in an upstream error body', async () => {
    stubForge(() => new Response('{"message":"bad credentials for token tok-123"}', { status: 401 }));
    const { s, id } = await workspaceWith({ configuredTracker: forgejoTracker });
    await s.app.ctx.secrets.set(id, 'FORGEJO_TOKEN', 'tok-123');

    const res = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);

    expect(res.body).toEqual({ ok: false, reason: 'GET /user failed: 401' });
    expect(JSON.stringify(res.body)).not.toContain('tok-123');
  });
});

describe('Forgejo Code Repository Secrets', () => {
  const origin = 'http://forge.test:3000/o/r.git';

  it('verify uses the stored token against the remote host and port', async () => {
    stubForge(() => json({ login: 'harmonic-bot' }));
    const { s, id } = await workspaceWith({ codeRepository: 'forgejo' }, origin);
    await s.app.ctx.secrets.set(id, 'FORGEJO_TOKEN', 'tok-123');

    const { body } = await s.api('POST', `/api/workspaces/${id}/repository/verify`);

    expect(body).toEqual({ ok: true, identity: 'forgejo' });
    expect(seen[0]).toMatchObject({ url: 'http://forge.test:3000/api/v1/user', authorization: 'token tok-123' });
  });

  it('openPR posts the pull request with the stored token', async () => {
    const { s, id } = await workspaceWith({ codeRepository: 'forgejo' }, origin);
    await s.app.ctx.secrets.set(id, 'FORGEJO_TOKEN', 'tok-123');
    const calls: Seen[] = [];
    const resolve = createRepositoryResolver(s.app.ctx.secrets, async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return json({ number: 1 }, 201);
    });
    const ws = await s.app.ctx.workspaces.get(id);

    const adapter = await resolve(ws.workingDir, workspaceTrackerSettings(ws));
    await adapter!.openPR({ branch: 'feat', baseBranch: 'develop', title: 'T', body: 'B' });

    expect(calls).toEqual([
      {
        url: 'http://forge.test:3000/api/v1/repos/o/r/pulls',
        method: 'POST',
        authorization: 'token tok-123',
        body: { head: 'feat', base: 'develop', title: 'T', body: 'B' },
      },
    ]);
  });

  it('has no adapter, rather than a half-built one, without a stored token', async () => {
    const { s, id } = await workspaceWith({ codeRepository: 'forgejo' }, origin);
    const ws = await s.app.ctx.workspaces.get(id);
    const resolve = createRepositoryResolver(s.app.ctx.secrets, async () => json({}));

    expect(await resolve(ws.workingDir, workspaceTrackerSettings(ws))).toBeNull();
  });

  const forgejoTracker = (baseUrl: string) => ({ kind: 'forgejo', settings: { baseUrl, repo: 'o/r', tokenSecret: 'TRACKER_TOKEN' } });
  const openPrAuth = async (s: TestServer, id: number): Promise<string | null | undefined> => {
    const calls: Seen[] = [];
    const resolve = createRepositoryResolver(s.app.ctx.secrets, async (url, init) => {
      calls.push({ url, method: 'POST', authorization: new Headers(init?.headers).get('authorization'), body: undefined });
      return json({}, 201);
    });
    const adapter = await resolve((await s.app.ctx.workspaces.get(id)).workingDir, workspaceTrackerSettings(await s.app.ctx.workspaces.get(id)));
    await adapter?.openPR({ branch: 'b', baseBranch: 'develop', title: 'T', body: 'B' });
    return calls[0]?.authorization;
  };

  it('uses the Forgejo tracker tokenSecret when the tracker is on the same host', async () => {
    const { s, id } = await workspaceWith({ codeRepository: 'forgejo', configuredTracker: forgejoTracker('http://forge.test:3000') }, origin);
    await s.app.ctx.secrets.set(id, 'FORGEJO_TOKEN', 'default-tok');
    await s.app.ctx.secrets.set(id, 'TRACKER_TOKEN', 'tracker-tok');

    expect(await openPrAuth(s, id)).toBe('token tracker-tok');
  });

  it('falls back to FORGEJO_TOKEN when the Forgejo tracker is on another host', async () => {
    const { s, id } = await workspaceWith({ codeRepository: 'forgejo', configuredTracker: forgejoTracker('https://other.test') }, origin);
    await s.app.ctx.secrets.set(id, 'FORGEJO_TOKEN', 'default-tok');
    await s.app.ctx.secrets.set(id, 'TRACKER_TOKEN', 'tracker-tok');

    expect(await openPrAuth(s, id)).toBe('token default-tok');
  });
});
