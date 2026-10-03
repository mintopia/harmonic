import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import '../src/tracker/kinds.js';
import { githubAdapter } from '../src/tracker/github.js';
import { gitlabAdapter } from '../src/tracker/gitlab.js';
import { seedWorkspace, startServer, type TestServer } from './helpers.js';

const dirs: string[] = [];
const repo = (declaration?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-tracker-settings-'));
  dirs.push(dir);
  if (declaration) {
    mkdirSync(join(dir, 'docs/agents'), { recursive: true });
    writeFileSync(join(dir, 'docs/agents/issue-tracker.md'), declaration);
  }
  return dir;
};
let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start = async (dir: string) => {
  server = await startServer();
  const id = await seedWorkspace(server.app.ctx.asyncDb);
  await server.app.ctx.workspaces.update(id, { workingDir: dir });
  return { s: server, id };
};

describe('GET /tracker-kinds', () => {
  it('lists every registered kind with its settings JSON Schema', async () => {
    server = await startServer();
    const { status, body } = await server.api('GET', '/api/tracker-kinds');
    expect(status).toBe(200);
    expect(body.kinds.map((k: { id: string }) => k.id)).toEqual(['github', 'gitlab', 'forgejo', 'jira', 'local-markdown']);
    const gitlab = body.kinds.find((k: { id: string }) => k.id === 'gitlab');
    expect(gitlab).toMatchObject({ label: expect.any(String), secretNames: expect.any(Array), capabilities: { close: true } });
    expect(gitlab.settingsSchema.type).toBe('object');
    const secretNames = Object.fromEntries(body.kinds.map((k: { id: string; secretNames: string[] }) => [k.id, k.secretNames]));
    expect(secretNames).toMatchObject({ forgejo: ['FORGEJO_TOKEN'], jira: ['JIRA_TOKEN'] });
    expect((await server.anonApi('GET', '/api/tracker-kinds')).status).toBe(401);
  });
});

describe('GET /workspaces/:id/tracker-detection', () => {
  it('reports the declared tracker as a registered kind and no code repository without an origin', async () => {
    const { s, id } = await start(repo('# Issue tracker: Local Markdown\n'));
    const { body } = await s.api('GET', `/api/workspaces/${id}/tracker-detection`);
    expect(body).toEqual({ detectedTracker: { name: 'Local Markdown', kind: 'local-markdown' }, detectedCodeRepository: null });
  });

  it('keeps an unregistered declared name with a null kind, and detects the origin host', async () => {
    const dir = repo('# Issue tracker: Linear\n');
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    const { s, id } = await start(dir);
    const { body } = await s.api('GET', `/api/workspaces/${id}/tracker-detection`);
    expect(body).toEqual({ detectedTracker: { name: 'Linear', kind: null }, detectedCodeRepository: 'github' });
  });

  it('reports no detected tracker without a declaration, and 404s an unknown Workspace', async () => {
    const { s, id } = await start(repo());
    expect((await s.api('GET', `/api/workspaces/${id}/tracker-detection`)).body.detectedTracker).toBeNull();
    expect((await s.api('GET', '/api/workspaces/99999/tracker-detection')).status).toBe(404);
  });
});

describe('POST /workspaces/:id/tracker/verify', () => {
  it('returns the identity of the Resolved Tracker', async () => {
    const { s, id } = await start(repo('# Issue tracker: Local Markdown\n'));
    const { status, body } = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, identity: 'local files' });
  });

  it('turns a resolution failure into ok:false instead of a 500', async () => {
    const { s, id } = await start(repo());
    const { status, body } = await s.api('POST', `/api/workspaces/${id}/tracker/verify`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, reason: expect.stringContaining('No tracker declaration') });
  });
});

describe('POST /workspaces/:id/repository/verify', () => {
  it('reports ok:false when no Code Repository adapter applies', async () => {
    const { s, id } = await start(repo());
    const { status, body } = await s.api('POST', `/api/workspaces/${id}/repository/verify`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, reason: expect.any(String) });
  });

  it('404s an unknown Workspace', async () => {
    server = await startServer();
    expect((await server.api('POST', '/api/workspaces/99999/repository/verify')).status).toBe(404);
  });
});

describe('identify', () => {
  it('reads the authenticated login from gh and the username from glab', async () => {
    const calls: string[][] = [];
    const gh = githubAdapter('/x', async (args) => (calls.push(args), 'octocat\n'));
    expect(await gh.identify?.()).toBe('octocat');
    expect(calls[0]).toEqual(['api', 'user', '--jq', '.login']);
    const gl = gitlabAdapter({ project: 'a/b', repoRoot: '/x' }, async () => JSON.stringify({ id: 7, username: 'tanuki' }));
    expect(await gl.identify?.()).toBe('tanuki');
  });
});
