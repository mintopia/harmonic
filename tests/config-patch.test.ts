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

  it('clears a configured command back to null', async () => {
    const withCommand = await server.api('PATCH', '/api/config', {
      verification: { command: { command: 'npm', args: ['test'] } },
    });
    expect(withCommand.body.verification.command.command).toBe('npm');

    const cleared = await server.api('PATCH', '/api/config', { verification: { command: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.verification.command).toBeNull();
  });

  it('accepts a maxSelfHeals patch and leaves autoAccept untouched', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    expect(current.verification.maxSelfHeals).toBe(1);

    const patched = await server.api('PATCH', '/api/config', { verification: { maxSelfHeals: 3 } });
    expect(patched.status).toBe(200);
    expect(patched.body.verification.maxSelfHeals).toBe(3);
    expect(patched.body.verification.autoAccept).toBe(false);
  });
});
