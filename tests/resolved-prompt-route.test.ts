import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { startServer, type TestServer } from './helpers.js';

describe('GET /api/attempts/:id/resolved-prompt', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-resolved-prompt-'));
  let server: TestServer;
  let attemptId: number;
  let attemptNumber: number;
  const locator = 'verification/pre-merge/7/prompt.md';
  const prompt = 'Review the change.\n\nVerified head: abc123\n'.repeat(5);

  const fetchPrompt = (id: number, loc: string) =>
    fetch(`${server.baseUrl}/api/attempts/${id}/resolved-prompt?locator=${encodeURIComponent(loc)}`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });

  beforeAll(async () => {
    server = await startServer({ defaults: { isolationMode: 'direct' } } as DeepPartial<AppConfig>, { dataDir: join(root, 'data') });
    const task = await server.api('POST', '/api/tasks', { prompt: 'resolved prompt', workingDir: root, isolationMode: 'direct' });
    const run = await server.app.ctx.attempts.create(task.body.id);
    attemptId = run.id;
    attemptNumber = run.number;
    const taskRow = await server.app.ctx.tasks.get(task.body.id);
    const writer = server.app.ctx.archive.criticStep(taskRow, run.number, 'pre-merge', '7');
    writer.appendPrompt(prompt);
    await writer.close();
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the archived critic prompt exactly as written', async () => {
    const res = await fetchPrompt(attemptId, locator);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(prompt);
  });

  it('serves one prompt of a multi-prompt file by index, and 404s past the end', async () => {
    const taskRow = await server.app.ctx.tasks.get((await server.app.ctx.attempts.get(attemptId)).taskId as number);
    const writer = server.app.ctx.archive.implementationStep(taskRow, attemptNumber);
    expect(await writer.appendPrompt('turn zero')).toBe(0);
    expect(await writer.appendPrompt('turn one\n\nwith a body')).toBe(1);
    await writer.close();
    const byIndex = (index: string) =>
      fetch(`${server.baseUrl}/api/attempts/${attemptId}/resolved-prompt?locator=${encodeURIComponent('implementation/prompt.md')}&index=${index}`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
    expect(await (await byIndex('0')).text()).toBe('turn zero');
    expect(await (await byIndex('1')).text()).toBe('turn one\n\nwith a body');
    expect((await byIndex('2')).status).toBe(404);
    expect((await byIndex('-1')).status).toBe(400);
    expect(await (await fetchPrompt(attemptId, 'implementation/prompt.md')).text()).toBe('turn zero\n\n---\n\nturn one\n\nwith a body');
  });

  it('404s for a missing prompt, an unknown attempt, a traversal, and a non-prompt file', async () => {
    expect((await fetchPrompt(attemptId, 'verification/pre-merge/99/prompt.md')).status).toBe(404);
    expect((await fetchPrompt(999_999, locator)).status).toBe(404);
    expect((await fetchPrompt(attemptId, '../../../../../prompt.md')).status).toBe(404);
    writeFileSync(join(root, 'secret.txt'), 'x');
    expect((await fetchPrompt(attemptId, 'verification/pre-merge/7/acp.jsonl')).status).toBe(404);
  });

  const fetchSegments = (id: number, loc: string) =>
    fetch(`${server.baseUrl}/api/attempts/${id}/resolved-prompt?locator=${encodeURIComponent(loc)}&segments=true`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });

  it('rejects segments=true combined with index instead of ignoring the index', async () => {
    const res = await fetch(`${server.baseUrl}/api/attempts/${attemptId}/resolved-prompt?locator=${encodeURIComponent('implementation/prompt.md')}&segments=true&index=1`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('index');
  });

  it('segments=true round-trips prompts that themselves contain the separator and rules', async () => {
    const taskRow = await server.app.ctx.tasks.get((await server.app.ctx.attempts.get(attemptId)).taskId as number);
    const prompts = ['Ticket body\n\n---\n\nmore body\n---\nend \u00e9\u4e2d', '\n\n---\n\n', 'steer: use the cache\n\n---\n\n', 'last'];
    const writer = server.app.ctx.archive.criticStep(taskRow, attemptNumber, 'pre-merge', 'seg');
    for (const text of prompts) writer.appendPrompt(text);
    await writer.close();
    const res = await fetchSegments(attemptId, 'verification/pre-merge/seg/prompt.md');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prompts });
    const plain = await fetchPrompt(attemptId, 'verification/pre-merge/seg/prompt.md');
    expect(await plain.text()).toBe(prompts.join('\n\n---\n\n'));
  });

  it('segments=true falls back to separator splitting for a legacy archive with no index', async () => {
    const taskRow = await server.app.ctx.tasks.get((await server.app.ctx.attempts.get(attemptId)).taskId as number);
    const writer = server.app.ctx.archive.criticStep(taskRow, attemptNumber, 'pre-merge', 'legacy');
    writer.appendPrompt('one');
    writer.appendPrompt('two');
    await writer.close();
    rmSync(join(await writer.dir, 'prompt.index.jsonl'));
    const res = await fetchSegments(attemptId, 'verification/pre-merge/legacy/prompt.md');
    expect(await res.json()).toEqual({ prompts: ['one', 'two'] });
  });

  it('segments=true 404s for a missing prompt, an unknown attempt, a traversal, and a non-prompt file', async () => {
    expect((await fetchSegments(attemptId, 'verification/pre-merge/99/prompt.md')).status).toBe(404);
    expect((await fetchSegments(999_999, locator)).status).toBe(404);
    expect((await fetchSegments(attemptId, '../../../../../prompt.md')).status).toBe(404);
    expect((await fetchSegments(attemptId, 'verification/pre-merge/7/prompt.index.jsonl')).status).toBe(404);
  });

  it('yields the event loop between chunks of a large prompt', async () => {
    const taskRow = await server.app.ctx.tasks.get((await server.app.ctx.attempts.get(attemptId)).taskId as number);
    const big = 'x'.repeat(200 * 1024);
    const writer = server.app.ctx.archive.criticStep(taskRow, attemptNumber, 'pre-merge', 'big');
    writer.appendPrompt(big);
    await writer.close();
    let yields = 0;
    const text = await server.app.ctx.archive.readArchivedPrompt(taskRow, attemptNumber, 'verification/pre-merge/big/prompt.md', async () => {
      yields++;
    });
    expect(text).toBe(big);
    expect(yields).toBeGreaterThanOrEqual(3);
  });
});
