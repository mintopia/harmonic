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

  it('404s for a missing prompt, an unknown attempt, a traversal, and a non-prompt file', async () => {
    expect((await fetchPrompt(attemptId, 'verification/pre-merge/99/prompt.md')).status).toBe(404);
    expect((await fetchPrompt(999_999, locator)).status).toBe(404);
    expect((await fetchPrompt(attemptId, '../../../../../prompt.md')).status).toBe(404);
    writeFileSync(join(root, 'secret.txt'), 'x');
    expect((await fetchPrompt(attemptId, 'verification/pre-merge/7/acp.jsonl')).status).toBe(404);
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
