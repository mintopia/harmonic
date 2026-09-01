import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { attempts, sessions, workspaces } from '../src/db/schema.js';

describe('dispatching a Run persists a durable Session (issue #141)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('records exactly one credential-free Session bound to the Run, without changing the Run/Task outcome', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working…' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ];
    const prompt = JSON.stringify({ updates, stopReason: 'end_turn' });

    const created = await server.api('POST', '/api/tasks', { prompt });
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const started = await server.api('POST', `/api/tasks/${taskId}/run`);
    expect(started.status).toBe(201);
    const attemptId = started.body.id;

    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');
    const runApi = (await server.api('GET', `/api/attempts/${attemptId}`)).body;
    expect(runApi).toMatchObject({ taskId, number: 1, state: 'completed', stopReason: 'end_turn' });

    const asyncDb = server.app.ctx.asyncDb;
    const runRow = (await asyncDb.read((d) => d.select().from(attempts).where(eq(attempts.id, attemptId)).get()))!;
    const workspace = (await asyncDb.read((d) => d.select().from(workspaces).get()))!;

    expect(runRow.sessionId).toBeTruthy();
    expect(runRow.sessionRowId).not.toBeNull();

    const matching = await asyncDb.read((d) =>
      d.select().from(sessions).where(eq(sessions.harnessSessionId, runRow.sessionId!)).all(),
    );
    expect(matching).toHaveLength(1);
    const session = matching[0]!;
    expect(session.id).toBe(runRow.sessionRowId);
    expect(session.harness).toBe('claude');
    expect(session.model).toBe('stub-model');
    expect(session.cwd).toBe(workspace.workingDir);
    expect(session.transcriptPath).toBeNull();

    const allSessions = await asyncDb.read((d) => d.select().from(sessions).all());
    expect(allSessions).toHaveLength(1);

    expect(() => JSON.parse(session.mcpTemplates)).not.toThrow();
    const templates = JSON.parse(session.mcpTemplates);
    expect(Array.isArray(templates)).toBe(true);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ name: 'harmonic', type: 'http' });
    expect(templates[0]).not.toHaveProperty('headers');
    expect(templates[0]).not.toHaveProperty('token');
    expect(templates[0]).not.toHaveProperty('authorization');
    expect(session.mcpTemplates).not.toMatch(/bearer/i);
    expect(session.mcpTemplates).not.toMatch(/authorization/i);

    expect(() => JSON.parse(session.capabilitySnapshot)).not.toThrow();
    const capabilities = JSON.parse(session.capabilitySnapshot);
    expect(capabilities).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    expect(session.supportsLoadSession).toBe(true);
    expect(['retiring', 'retired']).toContain(session.status);
    expect(session.lastActiveAt).toBeGreaterThan(0);

    expect(session.permissionMode).toBeNull();
  });
});
