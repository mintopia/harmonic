import { readFileSync } from 'node:fs';
import {
  JEV_CATEGORIES,
  type JevCategory,
  type JevFileScore,
  type JevScoreRequest,
  type JevScorer,
  type JevScorerInfo,
} from './types.js';

export interface ProviderConfig {
  provider: 'openrouter' | 'typesafe';
  url: string;
  model: string;
  apiKey: string | undefined;
}

export function resolveProviderConfig(env: NodeJS.ProcessEnv): ProviderConfig {
  const provider = (env.JEV_PROVIDER ?? 'openrouter').toLowerCase();
  if (provider === 'typesafe') {
    return {
      provider: 'typesafe',
      url: env.JEV_URL ?? 'https://api.typesafe.ai/v1/systemone',
      model: env.JEV_MODEL ?? 'jev-latest',
      apiKey: env.TYPESAFE_API_KEY,
    };
  }
  return {
    provider: 'openrouter',
    url: env.JEV_URL ?? 'https://openrouter.ai/api/alpha/decisions',
    model: env.JEV_MODEL ?? 'typesafe/jev-1.13',
    apiKey: env.OPENROUTER_API_KEY,
  };
}

export function inferRoleHint(repoRelativePath: string): string | undefined {
  const normalized = repoRelativePath.toLowerCase();
  const parts = new Set(normalized.split('/'));
  const name = parts.size > 0 ? (normalized.split('/').pop() ?? '') : normalized;
  const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;

  const hasSegment = (...keywords: string[]): boolean =>
    keywords.some((kw) => parts.has(kw)) || keywords.some((kw) => name.includes(kw));

  if (name.endsWith('.d.ts')) return 'type declaration file (no runtime logic)';
  if (hasSegment('__fixtures__', 'fixtures', 'fixture')) {
    return 'fixture (static test/dev data, no runtime logic)';
  }
  if (hasSegment('__mocks__', 'mocks', 'mock', 'stubs', 'stub')) {
    return 'mock/stub (test double, not production logic)';
  }
  if (hasSegment('stories', 'story', 'storybook') || name.includes('.stories.')) {
    return 'story file (UI showcase/narrative, not application logic)';
  }
  const testMarkers = ['.test', '_test', 'test_', '.spec', '_spec', 'spec_'];
  if (hasSegment('__tests__', 'tests', 'test', 'spec', 'specs') || testMarkers.some((m) => stem.includes(m))) {
    return 'test file';
  }
  return undefined;
}

export const CHUNK_CHARS = 40_000;

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    chunks.push(text.slice(i, i + CHUNK_CHARS));
  }
  return chunks.length > 0 ? chunks : [''];
}

export function buildState(path: string, text: string): Record<string, unknown> {
  const chunks = chunkText(text);
  const state: Record<string, unknown> = { path };
  const roleHint = inferRoleHint(path);
  if (roleHint) state.role_hint = roleHint;
  state.content =
    chunks.length === 1
      ? text
      : chunks.map((content, i) => ({ part: i + 1, of: chunks.length, content }));
  return state;
}

export interface JevQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

interface RawRubrics {
  [key: string]: unknown;
}

export function loadQuestions(): Record<JevCategory, JevQuestion> {
  const raw = JSON.parse(readFileSync(new URL('./rubrics.json', import.meta.url), 'utf8')) as RawRubrics;
  const questions = {} as Record<JevCategory, JevQuestion>;
  for (const category of JEV_CATEGORIES) {
    questions[category] = raw[category] as JevQuestion;
  }
  return questions;
}

export interface HttpJevScorerOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface JevAnswer {
  score?: number;
  confidence?: number;
}

function assertCategoryScored(
  answer: JevAnswer | undefined,
  category: JevCategory,
  path: string,
): asserts answer is Required<JevAnswer> {
  if (!answer || typeof answer.score !== 'number' || typeof answer.confidence !== 'number') {
    throw new Error(`Jev response missing category "${category}" for ${path}`);
  }
}

function extractAnswersTolerantOfMissingEnvelope(payload: JevResponsePayload): Record<string, JevAnswer> {
  return payload.answers ?? (payload as unknown as Record<string, JevAnswer>);
}

interface JevResponsePayload {
  answers?: Record<string, JevAnswer>;
  usage?: { cost?: number; input_tokens?: number };
  [key: string]: unknown;
}

export function createHttpJevScorer(options: HttpJevScorerOptions = {}): JevScorer {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 5;
  const config = resolveProviderConfig(env);
  const questions = loadQuestions();

  const info: JevScorerInfo = { provider: config.provider, model: config.model };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey ?? ''}`,
    'Content-Type': 'application/json',
  };
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/mintopia/harmonic';
    headers['X-Title'] = 'harmonic-jev-gate';
  }

  async function callJev(state: Record<string, unknown>): Promise<{ payload: JevResponsePayload; latencyMs: number }> {
    const body = JSON.stringify({ state, model: config.model, questions });
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const start = performance.now();
      let response: Response;
      try {
        response = await doFetch(config.url, { method: 'POST', headers, body });
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await sleep(Math.min(2 ** attempt, 30) * 1000);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Jev API unreachable: ${reason}`);
      }
      if (response.ok) {
        const payload = (await response.json()) as JevResponsePayload;
        return { payload, latencyMs: performance.now() - start };
      }
      const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
      const detail = await response.text();
      if (retryable && attempt < maxRetries - 1) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
        const waitSeconds = Math.min(retryAfterSeconds ?? 2 ** attempt, 30);
        await sleep(waitSeconds * 1000);
        continue;
      }
      throw new Error(`Jev API error ${response.status}: ${detail.slice(0, 300)}`);
    }
    throw new Error('Jev API error: retries exhausted');
  }

  return {
    info,
    available(): boolean {
      return Boolean(config.apiKey);
    },
    async score(req: JevScoreRequest): Promise<JevFileScore> {
      const state = buildState(req.path, req.content);
      const { payload, latencyMs } = await callJev(state);
      const answers = extractAnswersTolerantOfMissingEnvelope(payload);
      const categories = {} as Record<JevCategory, number>;
      const confidence = {} as Record<JevCategory, number>;
      for (const category of JEV_CATEGORIES) {
        const answer = answers[category];
        assertCategoryScored(answer, category, req.path);
        categories[category] = answer.score;
        confidence[category] = answer.confidence;
      }
      return {
        path: req.path,
        categories,
        confidence,
        latencyMs,
        costUsd: payload.usage?.cost ?? 0,
        inputTokens: payload.usage?.input_tokens ?? 0,
      };
    },
  };
}
