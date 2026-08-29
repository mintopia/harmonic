import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, DeepPartial } from '../src/config.js';
import { startServer, waitFor, type TestServer } from './helpers.js';

describe('GET /api/attempts/:id/log (issue #242)', () => {
  let server: TestServer;
  const workDir = mkdtempSync(join(tmpdir(), 'harmonic-run-log-work-'));
  const logDir = mkdtempSync(join(tmpdir(), 'harmonic-run-log-native-'));
  const sessionId = 'native-log-session';
  const transcriptPath = join(logDir, workDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

  beforeAll(async () => {
    mkdirSync(join(logDir, workDir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Native assistant output' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }),
        '{ partial line while the harness is flushing',
      ].join('\n'),
    );
    server = await startServer({
      defaults: { workingDir: workDir, isolationMode: 'direct' },
      chat: { harness: 'claude', model: 'stub-model' },
      harnesses: {
        claude: {
          command: process.execPath,
          args: [join(import.meta.dirname, 'stub-harness.mjs')],
          models: ['stub-model'],
          defaultModel: 'stub-model',
          sessionLogDir: logDir,
          env: { STUB_SESSION_ID: sessionId },
        },
      },
    } as DeepPartial<AppConfig>);
  });

  afterAll(async () => {
    await server?.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  async function startRun(scenario: object): Promise<{ runId: number; taskId: number }> {
    const task = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify(scenario),
      workingDir: workDir,
      isolationMode: 'direct',
    });
    const run = await server.api('POST', `/api/tasks/${task.body.id}/run`);
    await waitFor(async () => (await server.app.ctx.attempts.get(run.body.id)).sessionRowId ? true : undefined);
    return { runId: run.body.id, taskId: task.body.id };
  }

  it('reads the native transcript for a live Run, not run_events', async () => {
    const { runId, taskId } = await startRun({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'database-only output' } }],
      exit: 'hang',
    });

    const { status, body } = await server.api('GET', `/api/attempts/${runId}/log`);

    expect(status).toBe(200);
    expect(body.status).toBe('available');
    expect(body.events.map((event: { payload: { content?: { text?: string }; title?: string } }) => event.payload.content?.text ?? event.payload.title)).toEqual([
      'Native assistant output',
      'Read',
    ]);
    expect(JSON.stringify(body)).not.toContain('database-only output');
    await server.api('POST', `/api/tasks/${taskId}/cancel`);
    await waitFor(async () => (await server.app.ctx.attempts.get(runId)).endedAt ? true : undefined);
  });

  it('reads the native transcript after a Run finishes', async () => {
    const { runId, taskId } = await startRun({ updates: [], delayMs: 1 });
    await waitFor(async () => (await server.app.ctx.attempts.get(runId)).state !== 'running' ? true : undefined);

    const { status, body } = await server.api('GET', `/api/attempts/${runId}/log`);

    expect(status).toBe(200);
    expect(body.status).toBe('available');
    expect(body.events).toHaveLength(2);
    await server.api('POST', `/api/tasks/${taskId}/cancel`);
  });

  it('reports an unavailable log when the captured transcript disappears', async () => {
    const { runId } = await startRun({ updates: [], delayMs: 1 });
    unlinkSync(transcriptPath);

    const { status, body } = await server.api('GET', `/api/attempts/${runId}/log`);

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'unavailable', liveCursor: 0 });
  });
});
