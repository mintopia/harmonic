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

  it('drops a legacy verification.autoAccept patch — the review gate it toggled is gone (ADR-0041)', async () => {
    const current = (await server.api('GET', '/api/config')).body;
    expect(current.verify).not.toHaveProperty('autoAccept');

    const patched = await server.api('PATCH', '/api/config', { verification: { autoAccept: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.verify).not.toHaveProperty('autoAccept');
    expect(patched.body.verify.commands).toEqual([]);

    const after = await server.api('GET', '/api/config');
    expect(after.body.verify).not.toHaveProperty('autoAccept');
  });

  it('accepts a drive.continueAttempts patch and round-trips it (ADR-0044/#339 — parity with appConfig)', async () => {
    const patched = await server.api('PATCH', '/api/config', { drive: { continueAttempts: 4, mergeFate: 'open-PR' } });
    expect(patched.status).toBe(200);
    expect(patched.body.drive.continueAttempts).toBe(4);
    expect(patched.body.drive.mergeFate).toBe('open-PR');

    const after = await server.api('GET', '/api/config');
    expect(after.body.drive.continueAttempts).toBe(4);
  });

  it('accepts a command verifier and fills its defaults', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { commands: [{ command: 'npm', args: ['test'] }] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verify.commands[0].command).toBe('npm');
    expect(patched.body.verify.commands[0].args).toEqual(['test']);
    expect(patched.body.verify.commands[0].timeoutSeconds).toBe(600);
  });

  it('accepts an agent critic', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { review: { enabled: true, prompt: 'Review the diff.', model: 'claude-opus-5' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verify.review.model).toBe('claude-opus-5');
  });

  it('accepts a critic harness (issue #174) and round-trips it', async () => {
    const withHarness = await server.api('PATCH', '/api/config', {
      verify: { review: { enabled: true, prompt: 'Review the diff.', model: 'claude-opus-5', harness: 'codex' } },
    });
    expect(withHarness.status).toBe(200);
    expect(withHarness.body.verify.review.harness).toBe('codex');

    const after = await server.api('GET', '/api/config');
    expect(after.body.verify.review.harness).toBe('codex');
  });

  it('accepts a critic with no harness (issue #174) — the field is optional, "Same as task"', async () => {
    const patched = await server.api('PATCH', '/api/config', {
      verify: { review: { enabled: true, prompt: 'Review the diff.', model: 'claude-opus-5' } },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verify.review.harness).toBeUndefined();
  });

  it('rejects an invalid critic harness (issue #174) — not one of the known harness ids', async () => {
    const invalid = await server.api('PATCH', '/api/config', {
      verify: { review: { enabled: true, prompt: 'Review the diff.', model: 'claude-opus-5', harness: 'nonexistent' } },
    });
    expect(invalid.status).toBe(400);
  });

  it('clears a configured command back to null', async () => {
    const withCommand = await server.api('PATCH', '/api/config', {
      verify: { commands: [{ command: 'npm', args: ['test'] }] },
    });
    expect(withCommand.body.verify.commands[0].command).toBe('npm');

    const cleared = await server.api('PATCH', '/api/config', { verify: { commands: [] } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.verify.commands).toEqual([]);
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
});
