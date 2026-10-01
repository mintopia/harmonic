import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { truncationMarker } from '../src/verification/command-verifier.js';
import { startServer, type TestServer } from './helpers.js';

describe('GET /api/verification-attempts/:id/output', () => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-verify-output-'));
  let server: TestServer;
  let taskId: number;
  let attemptId: number;
  let outputPath: string;

  const addAttempt = async (output: string): Promise<number> =>
    (await server.app.ctx.verificationAttempts.append(attemptId, { mechanism: 'command', inputOid: 'a'.repeat(40), verdict: 'fail', summary: 'command exited 1', output })).id;

  const fetchOutput = (id: number) => fetch(`${server.baseUrl}/api/verification-attempts/${id}/output`, { headers: { cookie: `harmonic_session=${server.sessionToken}` } });

  beforeAll(async () => {
    server = await startServer({ defaults: { isolationMode: 'direct' } } as DeepPartial<AppConfig>, { dataDir: join(root, 'data') });
    const task = await server.api('POST', '/api/tasks', { prompt: 'verify output', workingDir: root, isolationMode: 'direct' });
    taskId = task.body.id;
    const run = await server.app.ctx.attempts.create(taskId);
    attemptId = run.id;
    const taskRow = await server.app.ctx.tasks.get(taskId);
    outputPath = (await server.app.ctx.archive.verificationOutputLog(taskRow, run.number, 'pre-merge', 'cmd-1'))!;
    writeFileSync(outputPath, 'FULL OUTPUT '.repeat(10));
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('streams the archived full output and hides the filesystem path from the attempts list', async () => {
    const id = await addAttempt(`head${truncationMarker(300_000, outputPath)}tail`);

    const res = await fetchOutput(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('FULL OUTPUT '.repeat(10));

    const list = await server.api('GET', `/api/attempts/${attemptId}/verification-attempts`);
    const row = list.body.verificationAttempts.find((a: { id: number }) => a.id === id);
    expect(row.outputTruncated).toBe(true);
    expect(row.output).toBe('head\n…[truncated 300000 chars]…\ntail');
    expect(JSON.stringify(list.body)).not.toContain(outputPath);
  });

  it('404s when the output was not truncated', async () => {
    const id = await addAttempt('short output');
    expect((await fetchOutput(id)).status).toBe(404);
    const list = await server.api('GET', `/api/attempts/${attemptId}/verification-attempts`);
    expect(list.body.verificationAttempts.find((a: { id: number }) => a.id === id).outputTruncated).toBe(false);
  });

  it('404s on a traversal segment instead of reading outside the Archive', async () => {
    const id = await addAttempt(`x${truncationMarker(10, join(root, 'data', 'archive', 'verification', 'pre-merge', '..', 'output.log'))}y`);
    expect((await fetchOutput(id)).status).toBe(404);
  });

  it('404s for an unknown attempt and when the archived file is gone', async () => {
    expect((await fetchOutput(999_999)).status).toBe(404);
    const id = await addAttempt(`x${truncationMarker(10, join(root, 'verification', 'post-merge', 'missing', 'output.log'))}y`);
    expect((await fetchOutput(id)).status).toBe(404);
  });

  it('flags a Critic transcript read from the Archive copy', async () => {
    const run = await server.app.ctx.attempts.get(attemptId);
    const taskRow = await server.app.ctx.tasks.get(taskId);
    const root = await server.app.ctx.archive.ensure(taskRow);
    const native = join(root, 'attempts', String(run.number), 'verification', 'pre-merge', 'critic-1', 'native');
    mkdirSync(native, { recursive: true });
    writeFileSync(
      join(native, 'crit.jsonl'),
      JSON.stringify({ timestamp: '2026-08-21T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'critic says pass' }] } }),
    );
    const critic = await server.app.ctx.verificationAttempts.append(attemptId, { mechanism: 'critic', inputOid: 'b'.repeat(40), verdict: 'pass', summary: 'ok', output: '', harness: 'codex' });
    await server.app.ctx.verificationAttempts.setTranscriptPath(critic.id, '/gone/crit.jsonl');

    const log = await server.api('GET', `/api/verification-attempts/${critic.id}/log`);
    expect(log.body).toMatchObject({ status: 'available', fromArchive: true });
    expect(log.body.events).toHaveLength(1);
  });
});
