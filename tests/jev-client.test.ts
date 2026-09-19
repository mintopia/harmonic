import { describe, expect, it, vi } from 'vitest';
import { JEV_CATEGORIES, type JevCategory } from '../scripts/jev/types.js';
import {
  buildState,
  CHUNK_CHARS,
  chunkText,
  createHttpJevScorer,
  inferRoleHint,
  JevFileTooBigError,
  loadQuestions,
  resolveProviderConfig,
} from '../scripts/jev/jev-client.js';

function allAnswers(score = 3): Record<JevCategory, { score: number; confidence: number }> {
  const answers = {} as Record<JevCategory, { score: number; confidence: number }>;
  for (const category of JEV_CATEGORIES) {
    answers[category] = { score, confidence: 0.9 };
  }
  return answers;
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

describe('resolveProviderConfig', () => {
  it('defaults to openrouter', () => {
    const config = resolveProviderConfig({ OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(config).toEqual({
      provider: 'openrouter',
      url: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKey: 'k',
    });
  });

  it('switches to typesafe url/model/key-env', () => {
    const config = resolveProviderConfig({ JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 't' } as NodeJS.ProcessEnv);
    expect(config).toEqual({
      provider: 'typesafe',
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKey: 't',
    });
  });

  it('respects JEV_URL and JEV_MODEL overrides', () => {
    const config = resolveProviderConfig({
      JEV_URL: 'https://example.test/jev',
      JEV_MODEL: 'custom-model',
    } as NodeJS.ProcessEnv);
    expect(config.url).toBe('https://example.test/jev');
    expect(config.model).toBe('custom-model');
  });
});

describe('inferRoleHint', () => {
  it('flags .d.ts files as type declarations', () => {
    expect(inferRoleHint('src/types.d.ts')).toMatch(/type declaration/);
  });

  it('flags fixtures directories', () => {
    expect(inferRoleHint('tests/fixtures/sample.ts')).toMatch(/fixture/);
  });

  it('flags mocks directories', () => {
    expect(inferRoleHint('src/mocks/api.ts')).toMatch(/mock/);
  });

  it('flags .stories.tsx files', () => {
    expect(inferRoleHint('web/src/Button.stories.tsx')).toMatch(/story/);
  });

  it('flags .test.ts and .spec.ts files', () => {
    expect(inferRoleHint('src/foo.test.ts')).toMatch(/test/);
    expect(inferRoleHint('src/foo.spec.ts')).toMatch(/test/);
  });

  it('returns undefined for an ordinary source file', () => {
    expect(inferRoleHint('src/foo.ts')).toBeUndefined();
  });

  it('resolves ambiguous paths by the same precedence as the reference (.d.ts before test)', () => {
    expect(inferRoleHint('tests/fixtures/schema.d.ts')).toMatch(/type declaration/);
  });
});

describe('chunkText / buildState', () => {
  it('keeps text under CHUNK_CHARS as a single string with no role_hint', () => {
    const text = 'x'.repeat(100);
    expect(chunkText(text)).toEqual([text]);
    const state = buildState('src/foo.ts', text);
    expect(state.content).toBe(text);
    expect(state).not.toHaveProperty('role_hint');
  });

  it('splits text over CHUNK_CHARS into contiguous, non-overlapping parts', () => {
    const text = 'a'.repeat(CHUNK_CHARS + 1234);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]?.length).toBe(CHUNK_CHARS);

    const state = buildState('src/foo.ts', text);
    const content = state.content as Array<{ part: number; of: number; content: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.map((c) => c.content).join('')).toBe(text);
    expect(content.map((c) => c.part)).toEqual([1, 2]);
    expect(content.every((c) => c.of === 2)).toBe(true);
  });

  it('includes role_hint when inferred', () => {
    const state = buildState('src/foo.test.ts', 'short');
    expect(state.role_hint).toMatch(/test/);
  });
});

describe('loadQuestions', () => {
  it('returns exactly the 7 categories, shaped correctly, excluding _meta', () => {
    const questions = loadQuestions();
    expect(Object.keys(questions).sort()).toEqual([...JEV_CATEGORIES].sort());
    expect(questions).not.toHaveProperty('_meta');
    for (const category of JEV_CATEGORIES) {
      const q = questions[category];
      expect(q.type).toBe('score');
      expect(typeof q.instructions).toBe('string');
      expect(q.criteria).toHaveLength(5);
    }
  });
});

describe('createHttpJevScorer availability', () => {
  it('is unavailable with no API key', () => {
    const scorer = createHttpJevScorer({ env: {} as NodeJS.ProcessEnv });
    expect(scorer.available()).toBe(false);
  });

  it('is available when OPENROUTER_API_KEY is set', () => {
    const scorer = createHttpJevScorer({ env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv });
    expect(scorer.available()).toBe(true);
  });

  it('exposes provider/model info', () => {
    const scorer = createHttpJevScorer({ env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv });
    expect(scorer.info).toEqual({ provider: 'openrouter', model: 'typesafe/jev-1.13' });
  });
});

describe('createHttpJevScorer scoring', () => {
  it('resolves a JevFileScore with all 7 categories and correct cost/tokens/latency', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse({ answers: allAnswers(2.5), usage: { cost: 0.01, input_tokens: 123 } }),
    );
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const result = await scorer.score({ path: 'src/foo.ts', content: 'hello' });
    expect(Object.keys(result.categories).sort()).toEqual([...JEV_CATEGORIES].sort());
    for (const category of JEV_CATEGORIES) {
      expect(result.categories[category]).toBe(2.5);
      expect(result.confidence[category]).toBe(0.9);
    }
    expect(result.costUsd).toBe(0.01);
    expect(result.inputTokens).toBe(123);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('throws instead of defaulting a missing category to 0', async () => {
    const incomplete = allAnswers();
    delete (incomplete as Partial<typeof incomplete>).security;
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ answers: incomplete, usage: {} }));
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    await expect(scorer.score({ path: 'src/foo.ts', content: 'hello' })).rejects.toThrow(/security/);
  });

  it('retries once on 429 with Retry-After then succeeds', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(jsonResponse({ answers: allAnswers(), usage: {} }));
    const fakeSleep = vi.fn().mockResolvedValue(undefined);
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: fakeSleep,
    });
    const result = await scorer.score({ path: 'src/foo.ts', content: 'hello' });
    expect(result.categories.security).toBe(3);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeSleep).toHaveBeenCalledTimes(1);
    expect(fakeSleep).toHaveBeenCalledWith(1000);
  });

  it('throws after exhausting retries on repeated 500s, with status in the message', async () => {
    const fakeFetch = vi.fn().mockImplementation(async () => jsonResponse({ error: 'boom' }, { status: 500 }));
    const fakeSleep = vi.fn().mockResolvedValue(undefined);
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: fakeSleep,
      maxRetries: 3,
    });
    await expect(scorer.score({ path: 'src/foo.ts', content: 'hello' })).rejects.toThrow(/500/);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('retries a network-level fetch rejection like a 5xx and throws a descriptive error after exhausting retries', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const fakeSleep = vi.fn().mockResolvedValue(undefined);
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: fakeSleep,
      maxRetries: 2,
    });
    await expect(scorer.score({ path: 'src/foo.ts', content: 'hello' })).rejects.toThrow(/ECONNRESET/);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeSleep).toHaveBeenCalledTimes(1);
  });

  it('rejects with JevFileTooBigError on a non-retryable 413, without retrying', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'payload too large' }, { status: 413 }));
    const fakeSleep = vi.fn().mockResolvedValue(undefined);
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: fakeSleep,
    });
    await expect(scorer.score({ path: 'src/foo.ts', content: 'hello' })).rejects.toBeInstanceOf(JevFileTooBigError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeSleep).toHaveBeenCalledTimes(0);
  });

  it('rejects with JevFileTooBigError on a non-retryable 400 whose body mentions context length', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'context length exceeded' }, { status: 400 }));
    const fakeSleep = vi.fn().mockResolvedValue(undefined);
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: fakeSleep,
    });
    await expect(scorer.score({ path: 'src/foo.ts', content: 'hello' })).rejects.toBeInstanceOf(JevFileTooBigError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('does not reclassify a 403 whose body coincidentally mentions "context length" as too-big', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'forbidden: context length policy violation' }, { status: 403 }));
    const fakeSleep = vi.fn().mockResolvedValue(undefined);
    const scorer = createHttpJevScorer({
      env: { OPENROUTER_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetch: fakeFetch as unknown as typeof fetch,
      sleep: fakeSleep,
    });
    const promise = scorer.score({ path: 'src/foo.ts', content: 'hello' });
    await expect(promise).rejects.not.toBeInstanceOf(JevFileTooBigError);
    await expect(promise).rejects.toThrow(/403/);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
