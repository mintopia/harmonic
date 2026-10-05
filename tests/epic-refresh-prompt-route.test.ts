import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackerRef } from '../src/tracker/adapter.js';
import { startServer, type TestServer } from './helpers.js';

describe('Epic refresh-resolver prompt routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-refresh-prompt-'));
  let server: TestServer;
  let base: string;
  const prompt = 'Resolve the merge.\n'.repeat(5);
  let locator: string;

  const get = (path: string) => fetch(`${server.baseUrl}${path}`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
  const fetchPrompt = (loc: string, ws = 1) => get(`/api/workspaces/${ws}/epics/42/refresh-prompt?locator=${encodeURIComponent(loc)}`);

  beforeAll(async () => {
    server = await startServer({}, { dataDir: join(root, 'data') });
    const ws = await server.api('POST', '/api/workspaces', { name: 'w', workingDir: root });
    base = `/api/workspaces/${ws.body.id}/epics/42`;
    const writer = server.app.ctx.archive.epicRefreshStep(ws.body.id, trackerRef(42), 'run1');
    writer.appendPrompt(prompt);
    await writer.close();
    locator = 'refresh/run1/prompt.md';
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists and serves the archived prompt as text/plain', async () => {
    const list = await get(`${base}/refresh-prompts`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { prompts: { locator: string; at: string }[] };
    expect(body.prompts.map((p) => p.locator)).toEqual([locator]);
    const res = await get(`${base}/refresh-prompt?locator=${encodeURIComponent(locator)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(prompt);
  });

  it('404s for missing, traversal, non-prompt files, and an unknown epic or workspace', async () => {
    const wsId = base.split('/')[3];
    const at = (loc: string) => get(`${base}/refresh-prompt?locator=${encodeURIComponent(loc)}`);
    expect((await at('refresh/nope/prompt.md')).status).toBe(404);
    expect((await at('../../../../prompt.md')).status).toBe(404);
    expect((await at('refresh/run1/acp.jsonl')).status).toBe(404);
    expect((await get(`/api/workspaces/${wsId}/epics/99/refresh-prompt?locator=${encodeURIComponent(locator)}`)).status).toBe(404);
    expect((await fetchPrompt(locator, 999_999)).status).toBe(404);
    const empty = await get(`/api/workspaces/${wsId}/epics/99/refresh-prompts`);
    expect(await empty.json()).toEqual({ prompts: [] });
  });
});
