import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { attempts, sessions, workspaces } from '../src/db/schema.js';

/**
 * Integration test for issue #141: dispatching a Run persists a durable
 * Session row alongside existing Run/Task state (reliability-design Unit C).
 *
 * `tests/execution.test.ts` is the template this is copied from (spawning a
 * Runner against the stub ACP harness end-to-end); `tests/sessions.test.ts`
 * (owned by a different agent) covers `SessionStore`/`stripMcpCredentials`/
 * `readLoadSessionCapability` as pure/store unit tests — this file proves the
 * real dispatch seam wires them together without changing Run/Task behaviour.
 */
describe('dispatching a Run persists a durable Session (issue #141)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  it('records exactly one credential-free Session bound to the Run, without changing the Run/Task outcome', async () => {
    // Same scenario shape as execution.test.ts's first test, so the
    // behavioural assertions below (task/run outcome) are directly
    // comparable to the pre-#141 baseline: the Session is written
    // *alongside*, not in place of, existing state.
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
    const runId = started.body.id;

    // --- Behaviour unchanged (AC 5): the Run still reaches the same
    // terminal state the plain execution test expects for this scenario shape. ---
    const task = await waitFor(async () => {
      const { body } = await server.api('GET', `/api/tasks/${taskId}`);
      return body.state === 'done' ? body : undefined;
    });
    expect(task.state).toBe('done');
    const runApi = (await server.api('GET', `/api/runs/${runId}`)).body;
    expect(runApi).toMatchObject({ taskId, attempt: 1, state: 'completed', stopReason: 'end_turn' });

    // --- The rest reads the durable rows directly (sessionRowId/session
    // internals aren't on the public Run API — same pattern execution.test.ts
    // uses to read guardrail_events straight off `server.app.ctx.db`). ---
    const asyncDb = server.app.ctx.asyncDb;
    const runRow = (await asyncDb.read((d) => d.select().from(attempts).where(eq(attempts.id, runId)).get()))!;
    const workspace = (await asyncDb.read((d) => d.select().from(workspaces).get()))!;

    // AC 2: the Run is bound to its Session.
    expect(runRow.sessionId).toBeTruthy();
    expect(runRow.sessionRowId).not.toBeNull();

    // AC 1: exactly one sessions row, keyed on the ACP session id, with the
    // dispatch identity (harness/model/cwd) matching the task/run.
    const matching = await asyncDb.read((d) =>
      d.select().from(sessions).where(eq(sessions.harnessSessionId, runRow.sessionId!)).all(),
    );
    expect(matching).toHaveLength(1);
    const session = matching[0]!;
    expect(session.id).toBe(runRow.sessionRowId);
    expect(session.harness).toBe('claude'); // stubHarness() registers the stub as 'claude' by default
    expect(session.model).toBe('stub-model'); // stubHarness()'s only/default model
    expect(session.cwd).toBe(workspace.workingDir);
    // The stub writes no native Claude JSONL. Dispatch remains healthy and
    // records the absence rather than inventing a path from the cwd slug.
    expect(session.transcriptPath).toBeNull();

    const allSessions = await asyncDb.read((d) => d.select().from(sessions).all());
    expect(allSessions).toHaveLength(1);

    // AC 3: mcpTemplates is credential-free. The test server always mints a
    // real Run Key and wires it into ACP session/new mcpServers (runner.ts:
    // `this.keys && this.mcpUrl` — both set once `startServer` has called
    // `listen()`), so this scenario genuinely exercised a credentialed
    // mcpServers list end-to-end; the stored template must not carry it.
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

    // AC 4: capabilitySnapshot captured, status/lastActiveAt set. The stub's
    // `initialize` reply now advertises `agentCapabilities.loadSession: true`
    // (tests/stub-harness.mjs — safe to change, nothing else in the suite
    // depended on the prior empty capabilities), so this is the strongest
    // end-to-end proof: supportsLoadSession reflects a real advertised `true`.
    expect(() => JSON.parse(session.capabilitySnapshot)).not.toThrow();
    const capabilities = JSON.parse(session.capabilitySnapshot);
    expect(capabilities).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    expect(session.supportsLoadSession).toBe(true);
    expect(['retiring', 'retired']).toContain(session.status); // the Run merged, so its Session is owed retirement (issue #148)
    expect(session.lastActiveAt).toBeGreaterThan(0);

    // Permission mode is only resolved for auto-driven (afk mirrored) Runs —
    // runner.ts sets it on the Session only inside the `autoDriven` branch,
    // after the handshake. This Run is a plain native dispatch (not afk), so
    // the mode is never set: null here is correct, not a gap.
    expect(session.permissionMode).toBeNull();
  });
});
