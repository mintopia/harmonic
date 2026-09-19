/**
 * Jev transport. Mirrors the shape and retry behaviour of the reference
 * implementation (`.claude/skills/jev-code-score/scripts/jev_score.py`):
 * one POST per file, body `{state, model, questions}`, native
 * `{answers, usage}` response (never a chat `choices[0].message` envelope),
 * exponential backoff honouring `Retry-After` on 429/5xx.
 * See `.claude/skills/jev-code-score/references/api.md`.
 */
import type { JevAnswer, JevUsage, Rubrics } from './types.js';

export interface JevProviderConfig {
  provider: 'openrouter' | 'typesafe';
  url: string;
  model: string;
  key: string;
  keyEnvVar: string;
}

export function resolveProviderConfig(): JevProviderConfig {
  const provider = (process.env['JEV_PROVIDER'] ?? 'openrouter').toLowerCase();
  if (provider === 'typesafe') {
    return {
      provider: 'typesafe',
      url: process.env['JEV_URL'] ?? 'https://api.typesafe.ai/v1/systemone',
      model: process.env['JEV_MODEL'] ?? 'jev-latest',
      key: process.env['TYPESAFE_API_KEY'] ?? '',
      keyEnvVar: 'TYPESAFE_API_KEY',
    };
  }
  return {
    provider: 'openrouter',
    url: process.env['JEV_URL'] ?? 'https://openrouter.ai/api/alpha/decisions',
    model: process.env['JEV_MODEL'] ?? 'typesafe/jev-1.13',
    key: process.env['OPENROUTER_API_KEY'] ?? '',
    keyEnvVar: 'OPENROUTER_API_KEY',
  };
}

export interface JevState {
  path: string;
  role_hint?: string;
  content: string | { part: number; of: number; content: string }[];
  diff: string;
}

export interface JevCallResult {
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callJev(cfg: JevProviderConfig, state: JevState, questions: Rubrics): Promise<JevCallResult> {
  const body = JSON.stringify({ state, model: cfg.model, questions });
  let lastError: Error = new Error('jev-gate: Jev API unreachable');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
    };
    if (cfg.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/mintopia/harmonic';
      headers['X-Title'] = 'harmonic-jev-gate';
    }

    let res: Response;
    try {
      res = await fetch(cfg.url, { method: 'POST', headers, body });
    } catch (err) {
      lastError = new Error(`jev-gate: Jev API unreachable: ${(err as Error).message}`);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw lastError;
    }

    if (res.ok) {
      const payload = (await res.json()) as { answers?: Record<string, JevAnswer>; usage?: JevUsage };
      return { answers: payload.answers ?? {}, usage: payload.usage ?? {} };
    }

    const detail = await res.text().catch(() => '');
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    lastError = new Error(`jev-gate: Jev API error ${res.status}: ${detail.slice(0, 300)}`);
    if (retryable && attempt < MAX_RETRIES - 1) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 2 ** attempt * 1000;
      await sleep(Math.min(waitMs, 30_000));
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

/** Bounded-concurrency `Promise` pool, mirroring the reference's `ThreadPoolExecutor(max_workers=concurrency)`. */
export async function runPool<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function runOne(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await worker(item, i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return results;
}
