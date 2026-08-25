import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { AcpDriver } from '../src/acp/driver.js';
import { graftMcpCredentials } from '../src/domain/sessions.js';

/**
 * The issue #143 seam test: `AcpDriver.load()` — the `session/load` resume
 * handshake — driven over a REAL spawned stub harness process, both
 * advertising and not-advertising `session/load` (AC7). Unlike
 * `tests/sessions.test.ts` (which drives the pure/store helpers in isolation)
 * this proves the driver's discriminated-union incompatibility outcomes and
 * the fresh-credential rebind (issue #143 AC5, via {@link graftMcpCredentials})
 * actually reach a live ACP process — AC1 ("fresh harness process": every
 * `load()` call here spawns its own child) and AC6 ("cold reload is not a
 * degraded path": a spawned stub process has no warm cache and `load()`
 * behaves identically to a warm one) fall out of that setup for free.
 *
 * Deps #141 (Session entity) and #142 (compat matrix) are built; this file
 * exercises the driver seam #142's `assessResumeEligibility` doesn't reach —
 * the live harness's own `initialize` re-advertisement.
 */

const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');

interface Rig {
  child: ChildProcess;
  driver: AcpDriver;
  /** Every `session/update` `update` object the stub emitted, in order. */
  updates: { sessionUpdate: string; [key: string]: unknown }[];
  /** The load-time replay flag (issue #144) delivered alongside each update in
   * `updates`, index-aligned — true while a `session/load` was in flight. */
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

/** The JSON-scenario text of a `session/update` `agent_message_chunk`, parsed. */
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
    const templates = [{ name: 'harmonic', type: 'http', url: 'http://x' }]; // credential-free, as stored
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
    // An incompatible outcome adopts no session — even though session/load was
    // sent to discover the modes, the driver holds no session state (#143 review).
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

    // The whole historical stream arrived during the load, each tagged replay.
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

    // A fresh prompt turn: its updates are current-turn output, never replay.
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
