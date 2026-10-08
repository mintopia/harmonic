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

  const makeAuth = (delays: number[]) => {
    const real = server.app.ctx.auth as unknown as { db: ConstructorParameters<typeof AuthService>[0] };
    return new AuthService(real.db, async (ms) => {
      delays.push(ms);
    });
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

  it('counts concurrent attempts so a parallel flood cannot beat the free failures', async () => {
    const delays: number[] = [];
    const auth = makeAuth(delays);
    await Promise.all(Array.from({ length: 8 }, () => auth.verifyLogin('wrong-password')));
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});
