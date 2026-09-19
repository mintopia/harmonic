import { afterEach, describe, expect, it, vi } from 'vitest';
import { callJev, JevFileTooBigError, type JevProviderConfig, type JevState } from '../scripts/jev-gate/jev-client.js';
import type { Rubrics } from '../scripts/jev-gate/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const cfg: JevProviderConfig = {
  provider: 'openrouter',
  url: 'https://example.test/decisions',
  model: 'typesafe/jev-1.13',
  key: 'test-key',
  keyEnvVar: 'OPENROUTER_API_KEY',
};

const state: JevState = { path: 'src/foo.ts', content: 'const x = 1;\n', diff: '' };
const questions = {} as Rubrics;

describe('callJev', () => {
  it('rejects with JevFileTooBigError on a 413, calling fetch exactly once', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('payload too large', { status: 413 }));
    vi.stubGlobal('fetch', fetch);

    await expect(callJev(cfg, state, questions)).rejects.toBeInstanceOf(JevFileTooBigError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects with JevFileTooBigError on a 400 whose body mentions context length', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('error: context length exceeded', { status: 400 }));
    vi.stubGlobal('fetch', fetch);

    await expect(callJev(cfg, state, questions)).rejects.toBeInstanceOf(JevFileTooBigError);
  });

  it('does NOT reclassify a 403 as JevFileTooBigError even if its body mentions context length', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('forbidden: context length policy', { status: 403 }));
    vi.stubGlobal('fetch', fetch);

    const promise = callJev(cfg, state, questions);
    await expect(promise).rejects.toBeInstanceOf(Error);
    await expect(promise).rejects.not.toBeInstanceOf(JevFileTooBigError);
  });

  it('does NOT reclassify a 401 as JevFileTooBigError even if its body mentions context length', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('unauthorized: context length policy', { status: 401 }));
    vi.stubGlobal('fetch', fetch);

    const promise = callJev(cfg, state, questions);
    await expect(promise).rejects.toBeInstanceOf(Error);
    await expect(promise).rejects.not.toBeInstanceOf(JevFileTooBigError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
