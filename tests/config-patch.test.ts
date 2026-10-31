import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { baselineConfig } from '../src/config.js';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('baseline model catalog', () => {
  it('keeps Claude sessions warm for one hour', () => {
    expect(baselineConfig().harnesses.claude.cacheWarmSeconds).toBe(3600);
  });

  it('registers a priced OpenCode catalog with its ACP command', () => {
    const config = baselineConfig();
    expect(config.harnesses.opencode).toMatchObject({
      command: 'opencode',
      args: ['acp'],
      defaultModel: 'meta/muse-spark-1.3-contributor',
      cacheWarmSeconds: 300,
    });
    expect(config.harnesses.opencode.models).toEqual([
      {
        id: 'meta/muse-spark-1.3',
        price: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 1_048_576,
      },
      {
        id: 'meta/muse-spark-1.3-contributor',
        price: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
        contextWindow: 1_048_576,
      },
      {
        id: 'deepseek/deepseek-v4.1-flash',
        price: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        contextWindow: 1_000_000,
      },
      {
        id: 'openrouter/anthropic/claude-sonnet-5.5',
        price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
        contextWindow: 1_000_000,
      },
      {
        id: 'openrouter/openai/gpt-6.1-sol',
        price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
        contextWindow: 1_050_000,
      },
      {
        id: 'openrouter/anthropic/claude-sonnet-5',
        price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1_000_000,
      },
      {
        id: 'openrouter/openai/gpt-5.6-sol',
        price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1_050_000,
      },
    ]);
    expect(config.defaults.harness).toBe('claude');
    expect(config.chat.harness).toBe('claude');
  });
});

describe('PATCH /api/config verification', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it('ignores the removed drive.continueAttempts and drive.mergeFate keys (ADR-0055)', async () => {
    const patched = await server.api('PATCH', '/api/config', { drive: { continueAttempts: 4, mergeFate: 'open-PR', commitNudge: 'Commit now.' } });
    expect(patched.status).toBe(200);
    expect(patched.body.drive.commitNudge).toBe('Commit now.');
    expect(patched.body.drive).not.toHaveProperty('continueAttempts');
    expect(patched.body.drive).not.toHaveProperty('mergeFate');
    expect((await server.api('GET', '/api/config')).body.drive).not.toHaveProperty('continueAttempts');
  });

  it('ignores the removed verify.task key (ADR-0055)', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [{ command: 'npm', args: ['test'] }], critics: [] } } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verify).not.toHaveProperty('task');
    expect(parse(readFileSync(join(server.dataDir, 'settings.yaml'), 'utf8')).global.verify?.task).toBeUndefined();
  });

  it('accepts a command verifier and fills its defaults', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [{ command: 'npm', args: ['test'] }], critics: [] } } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verify.epic.preMerge.commands[0].command).toBe('npm');
    expect(patched.body.verify.epic.preMerge.commands[0].args).toEqual(['test']);
    expect(patched.body.verify.epic.preMerge.commands[0].timeoutSeconds).toBe(600);
  });

  it('round-trips routingLabels through PATCH and refuses case-insensitive duplicates (ADR-0049)', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      routingLabels: [{ label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.routingLabels).toEqual([{ label: 'reasoning', harness: 'claude', model: 'claude-opus-5-5' }]);
    expect((await server.api('GET', '/api/config')).body.routingLabels).toHaveLength(1);

    const duplicate = await server.api('PATCH', '/api/config', {
      routingLabels: [
        { label: 'reasoning', harness: 'claude', model: '' },
        { label: 'REASONING', harness: 'codex', model: '' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect((await server.api('GET', '/api/config')).body.routingLabels).toHaveLength(1);

    const unknownHarness = await server.api('PATCH', '/api/config', {
      routingLabels: [{ label: 'x', harness: 'nope', model: '' }],
    });
    expect(unknownHarness.status).toBe(400);
  });

  it('accepts an agent critic', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [], critics: [{ name: 'Test critic', prompt: 'Review the diff.', model: 'stub-model', harness: 'claude' }] } } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verify.epic.preMerge.critics[0].model).toBe('stub-model');
  });

  it('accepts a critic harness (issue #174) and round-trips it', async () => {
    const withHarness = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [], critics: [{ name: 'Test critic', prompt: 'Review the diff.', model: 'gpt-6-sol', harness: 'codex' }] } } },
    });
    expect(withHarness.status).toBe(200);
    expect(withHarness.body.verify.epic.preMerge.critics[0].harness).toBe('codex');

    const after = await server.api('GET', '/api/config');
    expect(after.body.verify.epic.preMerge.critics[0].harness).toBe('codex');
  });

  it('rejects a critic with no harness', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [], critics: [{ name: 'Test critic', prompt: 'Review the diff.', model: 'claude-opus-5' }] } } },
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error.message).toContain('harness');
  });

  it('rejects a critic whose model is not in its harness, naming both', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [], critics: [{ name: 'Test critic', prompt: 'Review the diff.', model: 'gpt-6-sol', harness: 'claude' }] } } },
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error.message).toContain('gpt-6-sol');
    expect(patched.body.error.message).toContain('claude');
  });

  it('rejects an invalid critic harness (issue #174) — not one of the known harness ids', async () => {
    const invalid = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [], critics: [{ name: 'Test critic', prompt: 'Review the diff.', model: 'claude-opus-5', harness: 'nonexistent' }] } } },
    });
    expect(invalid.status).toBe(400);
  });

  it('clears a configured command back to null', async () => {
    const withCommand = await server.api('PATCH', '/api/config', {
      verify: { epic: { preMerge: { commands: [{ command: 'npm', args: ['test'] }], critics: [] } } },
    });
    expect(withCommand.body.verify.epic.preMerge.commands[0].command).toBe('npm');

    const cleared = await server.api('PATCH', '/api/config', { verify: { epic: { preMerge: { commands: [], critics: [] } } } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.verify.epic.preMerge.commands).toEqual([]);
  });

  it('accepts a maxAttempts patch and leaves verification settings untouched', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    expect(current.maxAttempts).toBe(2);

    const patched = await server.api('PATCH', '/api/config', { maxAttempts: 3 });
    expect(patched.status).toBe(200);
    expect(patched.body.maxAttempts).toBe(3);
    expect(patched.body.verify).toEqual(current.verify);
  });

  it('round-trips the global context reuse token limit', async () => {
    const patched = await server.api('PATCH', '/api/config', { contextReuseTokenLimit: 150_000 });
    expect(patched.status).toBe(200);
    expect(patched.body.contextReuseTokenLimit).toBe(150_000);
  });

  it('accepts a per-harness model catalog and cache warm duration', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      harnesses: {
        claude: {
          models: [{ id: 'custom-model', price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 128_000 }],
          defaultModel: 'custom-model',
          cacheWarmSeconds: 600,
        },
      },
      chat: { model: 'custom-model' },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.harnesses.claude.models).toEqual([
      { id: 'custom-model', price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 128_000 },
    ]);
    expect(patched.body.harnesses.claude.cacheWarmSeconds).toBe(600);
  });

  it('round-trips an optional per-harness unattended permission mode', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      harnesses: { claude: { permissionMode: 'bypassPermissions' } },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.harnesses.claude.permissionMode).toBe('bypassPermissions');
    expect((await server.api('GET', '/api/config')).body.harnesses.claude.permissionMode).toBe('bypassPermissions');
  });

  it('accepts an id-keyed model catalog patch without replacing untouched models', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      harnesses: { claude: { models: { 'claude-opus-5': { contextWindow: 123_456 } } } },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.harnesses.claude.models).toContainEqual(expect.objectContaining({ id: 'claude-opus-5', contextWindow: 123_456 }));
    expect(patched.body.harnesses.claude.models).toContainEqual(expect.objectContaining({ id: 'stub-model' }));
  });

  it('rejects duplicate ids within a harness catalog', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      harnesses: {
        claude: {
          models: [{ id: 'custom-model' }, { id: 'custom-model' }],
          defaultModel: 'custom-model',
          cacheWarmSeconds: 600,
        },
      },
    });

    expect(patched.status).toBe(400);
  });
});
