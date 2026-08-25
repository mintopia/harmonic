import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, stubHarness, type TestServer } from './helpers.js';

describe('PATCH /api/config verification', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer(stubHarness());
  });
  afterEach(async () => {
    await server.close();
  });

  it('accepts a partial verification patch (autoAccept only) and persists it', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    expect(current.verification.autoAccept).toBe(false);

    const patched = await server.api('PATCH', '/api/config', { verification: { autoAccept: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.verification.autoAccept).toBe(true);
    expect(patched.body.verification.command).toBeNull();

    const after = await server.api('GET', '/api/config');
    expect(after.body.verification.autoAccept).toBe(true);
  });

  it('accepts a command verifier and fills its defaults', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verification: { command: { command: 'npm', args: ['test'] } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verification.command.command).toBe('npm');
    expect(patched.body.verification.command.args).toEqual(['test']);
    expect(patched.body.verification.command.timeoutSeconds).toBe(600);
    expect(patched.body.verification.autoAccept).toBe(false);
  });

  it('accepts an agent critic', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verification: { critic: { prompt: 'Review the diff.', model: 'claude-opus-5' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verification.critic.model).toBe('claude-opus-5');
  });

  it('accepts a critic harness (issue #174) and round-trips it', async () => {
    const withHarness = await server.api('PATCH', '/api/config', {
      verification: { critic: { prompt: 'Review the diff.', model: 'claude-opus-5', harness: 'codex' } },
    });
    expect(withHarness.status).toBe(200);
    expect(withHarness.body.verification.critic.harness).toBe('codex');

    const after = await server.api('GET', '/api/config');
    expect(after.body.verification.critic.harness).toBe('codex');
  });

  it('accepts a critic with no harness (issue #174) — the field is optional, "Same as task"', async () => {
    // A fresh critic patched with no `harness` key at all validates and
    // resolves to "reuse the builder's harness" (no key present).
    const patched = await server.api('PATCH', '/api/config', {
      verification: { critic: { prompt: 'Review the diff.', model: 'claude-opus-5' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verification.critic.harness).toBeUndefined();
  });

  it('rejects an invalid critic harness (issue #174) — not one of the known harness ids', async () => {
    const invalid = await server.api('PATCH', '/api/config', {
      verification: { critic: { prompt: 'Review the diff.', model: 'claude-opus-5', harness: 'nonexistent' } },
    });
    expect(invalid.status).toBe(400);
  });

  it('clears a configured command back to null', async () => {
    const withCommand = await server.api('PATCH', '/api/config', {
      verification: { command: { command: 'npm', args: ['test'] } },
    });
    expect(withCommand.body.verification.command.command).toBe('npm');

    const cleared = await server.api('PATCH', '/api/config', { verification: { command: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.verification.command).toBeNull();
  });

  it('accepts a maxAttempts patch and leaves verification settings untouched', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    expect(current.maxAttempts).toBe(2);

    const patched = await server.api('PATCH', '/api/config', { maxAttempts: 3 });
    expect(patched.status).toBe(200);
    expect(patched.body.maxAttempts).toBe(3);
    expect(patched.body.verification.autoAccept).toBe(false);
  });
});
