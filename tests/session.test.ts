// Merged session suite (dispatch, on-demand transcript, AcpDriver.load handshake). Consolidated
// so the isolated-pool import graph is paid once; each source file's helpers stay block-scoped.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AcpDriver } from '../src/acp/driver.js';
import { type AppConfig, type DeepPartial } from '../src/config.js';
import { attempts, sessions, workspaces } from '../src/db/schema.js';
import { graftMcpCredentials } from '../src/domain/sessions.js';
import { startServer, stubHarness, type TestServer, waitFor } from './helpers.js';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { eq } from 'drizzle-orm';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== session-dispatch.test.ts =====
{
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
}

// ===== session-transcript-ondemand.test.ts =====
{
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
}

// ===== session-load.test.ts =====
{
  const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');

  interface Rig {
    child: ChildProcess;
    driver: AcpDriver;
    updates: { sessionUpdate: string; [key: string]: unknown }[];
    replayFlags: boolean[];
  }

  let activeChild: ChildProcess | undefined;
  const providers: NodeTracerProvider[] = [];

  function spawnRig(envOverrides: Record<string, string> = {}): Rig {
    const child = spawn(process.execPath, [STUB_HARNESS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    });
    activeChild = child;
    const updates: Rig['updates'] = [];
    const replayFlags: boolean[] = [];
    const driver = new AcpDriver(child, {
      onSessionUpdate: (update, replay) => {
        updates.push(update);
        replayFlags.push(replay);
      },
      onRequest: async () => null,
    });
    return { child, driver, updates, replayFlags };
  }

  function lastEchoedJson(updates: Rig['updates']): unknown {
    const chunk = [...updates]
      .reverse()
      .find((u) => u.sessionUpdate === 'agent_message_chunk') as
      | { content?: { text?: string } }
      | undefined;
    if (!chunk?.content?.text) throw new Error('no agent_message_chunk update was captured');
    return JSON.parse(chunk.content.text);
  }

  afterEach(() => {
    activeChild?.kill();
    activeChild = undefined;
    trace.disable();
    return Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  });

  describe('AcpDriver.load() — the session/load resume handshake (issue #143)', () => {
    it('records session/new as an Operation', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      provider.register();
      providers.push(provider);
      const { driver } = spawnRig({ STUB_SESSION_ID: 'operation-create' });

      await driver.handshake({ cwd: '/tmp/new-cwd' });

      const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'harmonic.session.create');
      expect(span?.attributes).toMatchObject({ 'session.id': 'operation-create' });
      expect(span?.status.code).toBe(0);
    });

    it('records the session/load handshake as an Operation', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      provider.register();
      providers.push(provider);
      const { driver } = spawnRig({ STUB_SESSION_ID: 'operation-load' });

      await driver.load({ sessionId: 'operation-load', cwd: '/tmp/reload-cwd' });

      const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'harmonic.session.load');
      expect(span?.attributes).toMatchObject({ 'session.id': 'operation-load' });
      expect(span?.status.code).toBe(0);
    });

    it('reloads a stored Session, re-verifies modes, and rebinds fresh MCP credentials onto the wire', async () => {
      const { driver, updates } = spawnRig({ STUB_SESSION_ID: 'resume-sess-1' });
      const templates = [{ name: 'harmonic', type: 'http', url: 'http://x' }];
      const outcome = await driver.load({
        sessionId: 'resume-sess-1',
        cwd: '/tmp/reload-cwd',
        mcpServers: graftMcpCredentials(templates, 'fresh-key-1'),
        modelId: 'm1',
        permissionMode: 'auto',
      });

      expect(outcome).toEqual({ loaded: true });
      expect(driver.sessionId).toBe('resume-sess-1');
      expect(driver.availableModes).toContain('auto');

      await driver.prompt([{ type: 'text', text: JSON.stringify({ echoSessionLoad: true, updates: [], stopReason: 'end_turn' }) }]);
      const echoed = lastEchoedJson(updates) as {
        sessionId: string;
        cwd: string;
        mcpServers: { headers?: { name: string; value: string }[] }[];
      };
      expect(echoed.cwd).toBe('/tmp/reload-cwd');
      expect(echoed.mcpServers[0]?.headers).toEqual([{ name: 'Authorization', value: 'Bearer fresh-key-1' }]);
    });

    it('a harness that does not advertise loadSession: incompatible, session/load never sent', async () => {
      const { driver } = spawnRig({ STUB_NO_LOAD_SESSION: '1' });
      const outcome = await driver.load({ sessionId: 'resume-sess-2', cwd: '/tmp/reload-cwd' });

      expect(outcome).toMatchObject({ loaded: false, reason: 'load-session-unsupported' });
      expect(driver.sessionId).toBe('');
    });

    it('additionalDirectories advertised: the requested roots reach session/load', async () => {
      const { driver, updates } = spawnRig({ STUB_SESSION_ID: 'resume-sess-3' });
      const outcome = await driver.load({
        sessionId: 'resume-sess-3',
        cwd: '/tmp/reload-cwd',
        additionalDirectories: ['/extra/root'],
      });
      expect(outcome).toEqual({ loaded: true });

      await driver.prompt([{ type: 'text', text: JSON.stringify({ echoSessionLoad: true, updates: [], stopReason: 'end_turn' }) }]);
      const echoed = lastEchoedJson(updates) as { additionalDirectories?: string[] };
      expect(echoed.additionalDirectories).toEqual(['/extra/root']);
    });

    it('additionalDirectories NOT advertised and roots requested: incompatible', async () => {
      const { driver } = spawnRig({ STUB_NO_ADDITIONAL_DIRS: '1', STUB_SESSION_ID: 'resume-sess-4' });
      const outcome = await driver.load({
        sessionId: 'resume-sess-4',
        cwd: '/tmp/reload-cwd',
        additionalDirectories: ['/extra/root'],
      });
      expect(outcome).toMatchObject({ loaded: false, reason: 'additional-directories-unsupported' });
    });

    it('additionalDirectories NOT advertised but no roots requested: the missing capability is irrelevant', async () => {
      const { driver } = spawnRig({ STUB_NO_ADDITIONAL_DIRS: '1', STUB_SESSION_ID: 'resume-sess-5' });
      const outcome = await driver.load({ sessionId: 'resume-sess-5', cwd: '/tmp/reload-cwd' });
      expect(outcome).toEqual({ loaded: true });
    });

    it('a requested permission mode the reloaded harness no longer advertises: incompatible', async () => {
      const { driver } = spawnRig({ STUB_MODES: 'default,auto', STUB_SESSION_ID: 'resume-sess-6' });
      const outcome = await driver.load({
        sessionId: 'resume-sess-6',
        cwd: '/tmp/reload-cwd',
        permissionMode: 'bypassPermissions',
      });
      expect(outcome).toMatchObject({ loaded: false, reason: 'permission-mode-unestablishable' });
      expect(driver.sessionId).toBe('');
    });
  });

  describe('load-time replay quarantine — the driver marks replayed history (issue #144)', () => {
    const HISTORY = [
      { sessionUpdate: 'tool_call', toolCallId: 'hist-1', title: 'Read', kind: 'read' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier turn' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'hist-1', status: 'completed', content: [] },
    ];

    it('tags every session/update the harness replays during session/load as replay=true', async () => {
      const { driver, updates, replayFlags } = spawnRig({
        STUB_SESSION_ID: 'replay-sess-1',
        STUB_REPLAY_ON_LOAD: JSON.stringify(HISTORY),
      });

      const outcome = await driver.load({ sessionId: 'replay-sess-1', cwd: '/tmp/reload-cwd' });
      expect(outcome).toEqual({ loaded: true });

      expect(updates.map((u) => u.sessionUpdate)).toEqual([
        'tool_call',
        'agent_message_chunk',
        'tool_call_update',
      ]);
      expect(replayFlags).toEqual([true, true, true]);
    });

    it('tags the current turn (post-load session/prompt) as replay=false', async () => {
      const { driver, updates, replayFlags } = spawnRig({
        STUB_SESSION_ID: 'replay-sess-2',
        STUB_REPLAY_ON_LOAD: JSON.stringify(HISTORY),
      });

      await driver.load({ sessionId: 'replay-sess-2', cwd: '/tmp/reload-cwd' });
      const replayCount = updates.length;
      expect(replayFlags.slice(0, replayCount).every((r) => r === true)).toBe(true);

      await driver.prompt([
        {
          type: 'text',
          text: JSON.stringify({
            updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live now' } }],
            stopReason: 'end_turn',
          }),
        },
      ]);

      const currentFlags = replayFlags.slice(replayCount);
      expect(currentFlags.length).toBeGreaterThan(0);
      expect(currentFlags.every((r) => r === false)).toBe(true);
    });
  });

  describe('graftMcpCredentials (issue #143)', () => {
    it('re-attaches a fresh Authorization header onto a credential-free http template', () => {
      const templates = [{ name: 'harmonic', type: 'http', url: 'u' }];
      const result = graftMcpCredentials(templates, 'k') as Record<string, unknown>[];
      expect(result[0]!.headers).toEqual([{ name: 'Authorization', value: 'Bearer k' }]);
    });

    it('a non-array input yields []', () => {
      expect(graftMcpCredentials(undefined, 'k')).toEqual([]);
      expect(graftMcpCredentials({}, 'k')).toEqual([]);
      expect(graftMcpCredentials(null, 'k')).toEqual([]);
    });

    it('non-http entries pass through untouched', () => {
      const templates = [{ name: 'stdio-server', type: 'stdio', command: 'foo' }];
      expect(graftMcpCredentials(templates, 'k')).toEqual(templates);
    });

    it('round-trips through stripMcpCredentials: the grafted server carries the fresh token and nothing else secret', async () => {
      const { stripMcpCredentials } = await import('../src/domain/sessions.js');
      const adapterServers = [
        {
          name: 'harmonic',
          type: 'http',
          url: 'http://x',
          headers: [{ name: 'Authorization', value: 'Bearer OLD-SECRET' }],
        },
      ];
      const stored = stripMcpCredentials(adapterServers);
      const regrafted = graftMcpCredentials(stored, 'k') as Record<string, unknown>[];
      expect(regrafted[0]!.headers).toEqual([{ name: 'Authorization', value: 'Bearer k' }]);
      expect(JSON.stringify(regrafted)).not.toContain('OLD-SECRET');
    });
  });
}
