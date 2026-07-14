import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp, type App } from '../src/server/app.js';
import type { DeepPartial } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');

/** Config overrides registering the stub ACP agent as the `claude` harness. */
export function stubHarness(): DeepPartial<AppConfig> {
  return {
    harnesses: {
      claude: {
        command: process.execPath,
        args: [STUB_HARNESS],
        models: ['stub-model'],
        defaultModel: 'stub-model',
      },
    },
  } as DeepPartial<AppConfig>;
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const TEST_PASSWORD = 'test-password';

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  app: App;
  /** Session token, usable as `?token=` for WebSocket connections. */
  sessionToken: string;
  /** Authenticated JSON fetch helper: returns { status, body } without throwing. */
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** Same, but sends no credentials. */
  anonApi: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startServer(
  configOverrides?: DeepPartial<AppConfig>,
  opts: { dataDir?: string; password?: string; username?: string } = {},
): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'agentdeck-test-'));
  const app = await buildApp({
    dataDir,
    configOverrides,
    password: opts.password ?? TEST_PASSWORD,
    username: opts.username,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request =
    (headers: Record<string, string>) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(baseUrl + path, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

  // The house test style drives the API as the SPA does: log in, keep the
  // session cookie.
  const anonApi = request({});
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: opts.password ?? TEST_PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie') ?? '';
  const sessionToken = cookie.match(/agentdeck_session=([^;]+)/)?.[1] ?? '';
  const api = request({ cookie: `agentdeck_session=${sessionToken}` });

  return {
    baseUrl,
    dataDir,
    app,
    sessionToken,
    api,
    anonApi,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
