import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

/**
 * The chat default (ADR-0012): a new Conversation starts with its own default
 * Harness and model — separate from the Task defaults, resolved like every
 * other overridable setting (request value → Workspace override → global
 * chat default). Creation never spawns a harness, so these configs point at
 * placeholder commands: only the resolution matters here.
 */
const twoHarnessConfig: DeepPartial<AppConfig> = {
  harnesses: {
    claude: { command: 'noop', args: [], models: ['claude-a', 'claude-b'], defaultModel: 'claude-a' },
    codex: { command: 'noop', args: [], models: ['codex-a', 'codex-b'], defaultModel: 'codex-a' },
  },
  // Tasks default to claude; chat deliberately points elsewhere to prove the
  // two are independent.
  defaults: { harness: 'claude' },
  chat: { harness: 'codex', model: 'codex-b' },
};

describe('Conversation chat defaults (ADR-0012)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(twoHarnessConfig);
  });
  afterEach(async () => {
    await server.close();
  });

  it('a new Conversation uses the global chat default, not the Task default', async () => {
    const { status, body } = await server.api('POST', '/api/conversations', {});
    expect(status).toBe(201);
    expect(body.harness).toBe('codex'); // chat default, not the claude Task default
    expect(body.model).toBe('codex-b'); // the chat default model
  });

  it("a Workspace's chat override wins over the global chat default", async () => {
    const ws = server.app.ctx.workspaces.resolve();
    server.app.ctx.workspaces.update(ws.id, { chatHarness: 'claude', chatModel: 'claude-b' });

    const { body } = await server.api('POST', '/api/conversations', {});
    expect(body.harness).toBe('claude');
    expect(body.model).toBe('claude-b');
  });

  it('an explicit request harness/model wins over both', async () => {
    const ws = server.app.ctx.workspaces.resolve();
    server.app.ctx.workspaces.update(ws.id, { chatHarness: 'claude', chatModel: 'claude-b' });

    const { body } = await server.api('POST', '/api/conversations', { harness: 'codex', model: 'codex-a' });
    expect(body.harness).toBe('codex');
    expect(body.model).toBe('codex-a');
  });

  it('rejects when the resolved chat harness is not configured on this instance', async () => {
    // A Workspace chat override is free text, so it can name a harness this
    // instance doesn't configure — the handler guards it at create time.
    const ws = server.app.ctx.workspaces.resolve();
    server.app.ctx.workspaces.update(ws.id, { chatHarness: 'ghost' });

    const { status } = await server.api('POST', '/api/conversations', {});
    expect(status).toBe(400);
  });
});
