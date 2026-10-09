import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, TEST_PASSWORD, type TestServer } from './helpers.js';
import { AuthService } from '../src/server/auth.js';

describe('login back-off', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const makeAuth = (delays: number[], now?: () => number) => {
    const real = server.app.ctx.auth as unknown as { db: ConstructorParameters<typeof AuthService>[0] };
    return new AuthService(real.db, async (ms) => {
      delays.push(ms);
    }, now);
  };

  it('allows 5 free failures, then delays 1s doubling up to 60s', async () => {
    const delays: number[] = [];
    const auth = makeAuth(delays);
    for (let i = 0; i < 5; i++) expect(await auth.verifyLogin('wrong-password')).toBe(false);
    expect(delays).toEqual([]);
    for (let i = 0; i < 9; i++) await auth.verifyLogin('wrong-password');
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  it('delays even a correct password during back-off, and a success resets it', async () => {
    const delays: number[] = [];
    const auth = makeAuth(delays);
    for (let i = 0; i < 6; i++) await auth.verifyLogin('wrong-password');
    expect(delays).toEqual([1000]);
    expect(await auth.verifyLogin(TEST_PASSWORD)).toBe(true);
    expect(delays).toEqual([1000, 2000]);
    await auth.verifyLogin('wrong-password');
    expect(delays).toEqual([1000, 2000]);
  });

  it('forgets old failures after the decay window', async () => {
    const delays: number[] = [];
    let t = 1_000_000;
    const auth = makeAuth(delays, () => t);
    for (let i = 0; i < 6; i++) await auth.verifyLogin('wrong-password');
    expect(delays).toEqual([1000]);
    t += 14 * 60_000;
    await auth.verifyLogin('wrong-password');
    expect(delays).toEqual([1000, 2000]);
    t += 16 * 60_000;
    for (let i = 0; i < 5; i++) await auth.verifyLogin('wrong-password');
    expect(delays).toEqual([1000, 2000]);
  });

  it('rejects concurrent attempts during back-off instead of hashing them', async () => {
    const delays: number[] = [];
    const auth = makeAuth(delays);
    const results = await Promise.allSettled(
      Array.from({ length: 1000 }, () => auth.verifyLogin('wrong-password')),
    );
    const rejected = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'rate_limited',
    );
    expect(delays).toEqual([1000]);
    expect(rejected).toHaveLength(1000 - 6);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
  });

  it('answers 429 over HTTP once back-off is active', async () => {
    const s = await startServer();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await s.anonApi('POST', '/api/auth/login', { password: 'nope' })).status);
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      const flood = await Promise.all(
        Array.from({ length: 5 }, () => s.anonApi('POST', '/api/auth/login', { password: 'nope' })),
      );
      expect(flood.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(4);
    } finally {
      await s.close();
    }
  });
});
