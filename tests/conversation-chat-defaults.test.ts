import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, type TestServer } from './helpers.js';
import type { DeepPartial, AppConfig } from '../src/config.js';

const twoHarnessConfig: DeepPartial<AppConfig> = {
  harnesses: {
    claude: { command: 'noop', args: [], models: ['claude-a', 'claude-b'], defaultModel: 'claude-a' },
    codex: { command: 'noop', args: [], models: ['codex-a', 'codex-b'], defaultModel: 'codex-a' },
  },
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
    expect(body.harness).toBe('codex');
    expect(body.model).toBe('codex-b');
  });

  it("a Workspace's chat override wins over the global chat default", async () => {
    const ws = await server.app.ctx.workspaces.resolve();
    await server.app.ctx.workspaces.update(ws.id, { chatHarness: 'claude', chatModel: 'claude-b' });

    const { body } = await server.api('POST', '/api/conversations', {});
    expect(body.harness).toBe('claude');
    expect(body.model).toBe('claude-b');
  });

  it('an explicit request harness/model wins over both', async () => {
    const ws = await server.app.ctx.workspaces.resolve();
    await server.app.ctx.workspaces.update(ws.id, { chatHarness: 'claude', chatModel: 'claude-b' });

    const { body } = await server.api('POST', '/api/conversations', { harness: 'codex', model: 'codex-a' });
    expect(body.harness).toBe('codex');
    expect(body.model).toBe('codex-a');
  });

  it('rejects when the resolved chat harness is not configured on this instance', async () => {
    const ws = await server.app.ctx.workspaces.resolve();
    await server.app.ctx.workspaces.update(ws.id, { chatHarness: 'ghost' });

    const { status } = await server.api('POST', '/api/conversations', {});
    expect(status).toBe(400);
  });
});
