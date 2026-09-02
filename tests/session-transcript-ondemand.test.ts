import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { attempts, sessions } from '../src/db/schema.js';
import type { AppConfig, DeepPartial } from '../src/config.js';

describe('on-demand transcript resolution (Runner.ensureSessionTranscript)', () => {
  let server: TestServer;
  let logDir: string;

  beforeAll(async () => {
    logDir = mkdtempSync(join(tmpdir(), 'harmonic-transcript-'));
    const config = stubHarness();
    (config.harnesses as { claude: { sessionLogDir?: string } }).claude.sessionLogDir = logDir;
    server = await startServer(config as DeepPartial<AppConfig>);
  });
  afterAll(async () => {
    await server.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  it('resolves and persists the transcript path after the eager capture missed it', async () => {
    const prompt = JSON.stringify({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }],
      stopReason: 'end_turn',
    });
    const created = await server.api('POST', '/api/tasks', { prompt });
    const taskId = created.body.id;
    const attemptId = (await server.api('POST', `/api/tasks/${taskId}/run`)).body.id;
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });

    const asyncDb = server.app.ctx.asyncDb;
    const runRow = (await asyncDb.read((d) => d.select().from(attempts).where(eq(attempts.id, attemptId)).get()))!;
    const sessionId = runRow.sessionRowId!;
    const before = (await asyncDb.read((d) => d.select().from(sessions).where(eq(sessions.id, sessionId)).get()))!;
    expect(before.transcriptPath).toBeNull();

    const projectDir = join(logDir, 'some-project');
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, `${before.harnessSessionId}.jsonl`);
    writeFileSync(jsonlPath, '{"type":"summary"}\n');
    const jsonl = realpathSync(jsonlPath);

    const resolved = await server.app.ctx.runner.ensureSessionTranscript(sessionId);
    expect(resolved).toBe(jsonl);

    const after = (await asyncDb.read((d) => d.select().from(sessions).where(eq(sessions.id, sessionId)).get()))!;
    expect(after.transcriptPath).toBe(jsonl);
  });

  it('returns null without inventing a path when no log exists', async () => {
    const prompt = JSON.stringify({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }],
      stopReason: 'end_turn',
    });
    const taskId = (await server.api('POST', '/api/tasks', { prompt })).body.id;
    const attemptId = (await server.api('POST', `/api/tasks/${taskId}/run`)).body.id;
    await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    const asyncDb = server.app.ctx.asyncDb;
    const runRow = (await asyncDb.read((d) => d.select().from(attempts).where(eq(attempts.id, attemptId)).get()))!;
    expect(await server.app.ctx.runner.ensureSessionTranscript(runRow.sessionRowId!)).toBeNull();
  });
});
