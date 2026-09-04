import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter } from '../src/execution/harness/adapter.js';
import * as registry from '../src/execution/harness/registry.js';
import { startServer, type TestServer } from './helpers.js';

describe('harness discovery API (issue #490)', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
    server = undefined;
  });

  it('returns empty discovery results for harnesses without capabilities', async () => {
    server = await startServer();

    await expect(server.api('GET', '/api/harnesses/claude/providers')).resolves.toMatchObject({ status: 200, body: { providers: [] } });
    await expect(server.api('GET', '/api/harnesses/claude/models?provider=anthropic')).resolves.toMatchObject({ status: 200, body: { models: [] } });
  });

  it('dispatches provider and model discovery to an adapter capability', async () => {
    const selectProvider = vi.fn().mockResolvedValue([{ id: 'openai', label: 'OpenAI', authed: true }]);
    const selectModel = vi.fn().mockResolvedValue([{ id: 'gpt-5.6', label: 'GPT-5.6', price: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 }, contextWindow: 400_000 }]);
    const adapter: HarnessAdapter = {
      commandPrefix: '/',
      transcript: null,
      spawnEnv: () => ({}),
      mcpServers: () => [],
      unattendedPermissionMode: () => undefined,
      requiresUnattendedPermissionMode: false,
      usage: null,
      capabilities: { selectProvider, selectModel },
    };
    vi.spyOn(registry, 'adapterFor').mockReturnValue(adapter);
    server = await startServer();

    await expect(server.api('GET', '/api/harnesses/opencode/providers')).resolves.toMatchObject({ status: 200, body: { providers: [{ id: 'openai', authed: true }] } });
    await expect(server.api('GET', '/api/harnesses/opencode/models?provider=openai')).resolves.toMatchObject({ status: 200, body: { models: [{ id: 'gpt-5.6', contextWindow: 400_000 }] } });
    expect(selectModel).toHaveBeenCalledWith('openai');
  });

  it('requires a provider when listing models', async () => {
    server = await startServer();
    await expect(server.api('GET', '/api/harnesses/opencode/models')).resolves.toMatchObject({ status: 400, body: { error: { code: 'validation' } } });
  });
});
