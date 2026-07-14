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

export interface TestServer {
  baseUrl: string;
  dataDir: string;
  app: App;
  /** JSON fetch helper: returns { status, body } without throwing. */
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

export async function startServer(
  configOverrides?: DeepPartial<AppConfig>,
  opts: { dataDir?: string } = {},
): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'agentdeck-test-'));
  const app = await buildApp({ dataDir, configOverrides });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    baseUrl,
    dataDir,
    app,
    api,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
