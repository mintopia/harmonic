import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter } from './adapter.js';
import type { ModelPrice } from '../../domain/pricing.js';

type JsonRecord = Record<string, unknown>;

const modelsFile = () => join(homedir(), '.cache', 'opencode', 'models.json');
const authFile = () => join(homedir(), '.local', 'share', 'opencode', 'auth.json');

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function priceFrom(value: unknown): ModelPrice | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonnegativeNumber(value.input);
  const output = nonnegativeNumber(value.output);
  const cacheRead = nonnegativeNumber(value.cache_read);
  const cacheWrite = nonnegativeNumber(value.cache_write);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

async function readJson(path: string): Promise<JsonRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function localMetadata(): Promise<{ providers: JsonRecord; auth: JsonRecord } | null> {
  const [providers, auth] = await Promise.all([readJson(modelsFile()), readJson(authFile())]);
  return providers ? { providers, auth: auth ?? {} } : null;
}

const capabilities = {
  async selectProvider() {
    const metadata = await localMetadata();
    if (!metadata) return [];

    return Object.entries(metadata.providers).flatMap(([id, provider]) => {
      if (!isRecord(provider) || (id !== 'opencode' && !isRecord(metadata.auth[id]))) return [];
      return [{ id, label: stringValue(provider.name, id), authed: id !== 'opencode' }];
    });
  },

  async selectModel(providerId: string) {
    const metadata = await localMetadata();
    const provider = metadata?.providers[providerId];
    if (!metadata || !isRecord(provider) || (providerId !== 'opencode' && !isRecord(metadata.auth[providerId]))) return [];
    if (!isRecord(provider.models)) return [];

    return Object.entries(provider.models).flatMap(([id, model]) => {
      if (!isRecord(model)) return [];
      const contextWindow = isRecord(model.limit) ? positiveInteger(model.limit.context) : undefined;
      const price = priceFrom(model.cost);
      return [{
        id: `${providerId}/${id}`,
        label: stringValue(model.name, id),
        ...(price ? { price } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }];
    });
  },
};

export const opencodeAdapter: HarnessAdapter = {
  commandPrefix: '/',
  transcript: null,
  spawnEnv: () => ({}),
  sessionModelId: (model) => model,
  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],
  unattendedPermissionMode: () => undefined,
  requiresUnattendedPermissionMode: false,
  usage: null,
  capabilities,
};
