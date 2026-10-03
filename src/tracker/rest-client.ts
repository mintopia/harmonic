import { z, type ZodType } from 'zod';
import type { TrackerHttp } from './kind.js';

export class RestError extends Error {
  /** The failure without the response body, which can echo a credential; safe to show a user. */
  readonly safeReason: string;

  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    safeReason?: string,
  ) {
    super(message);
    this.name = 'RestError';
    this.safeReason = safeReason ?? message;
  }
}

/** An error's message, minus any response body a {@link RestError} carries. */
export function safeErrorReason(err: unknown): string {
  return err instanceof RestError ? err.safeReason : err instanceof Error ? err.message : String(err);
}

export interface RestClientOptions {
  /** API root every path is relative to, e.g. `https://forge.example/api/v1`. */
  baseUrl: string;
  headers: Record<string, string>;
  http: TrackerHttp;
  /** Retries after the first attempt; a bounded count so a dead host cannot spin the loop (ADR-0007, #219). Default 3. */
  retries?: number;
  /** Delay before retry `n` (0-based) in ms when the server names none. Default 250 * 2^n. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RestClient {
  /** One request whose JSON reply must match `schema`; a reply that does not is a {@link RestError}. */
  request<T>(method: string, path: string, schema: ZodType<T>, body?: unknown): Promise<T>;
  /** One request whose reply body is ignored. */
  send(method: string, path: string, body?: unknown): Promise<void>;
  /** Every item of a page-numbered list endpoint, each matching `item`, stopping at the first short page. */
  paginate<T>(path: string, pageSize: number, item: ZodType<T>, maxPages?: number): Promise<T[]>;
}

const MAX_RETRY_AFTER_MS = 5000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A transient failure worth retrying: 429 always; 5xx only for idempotent methods, since a POST may already have landed. */
function retryable(method: string, status: number): boolean {
  return status === 429 || (status >= 500 && IDEMPOTENT.has(method));
}

function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
}

/** A small JSON REST client: auth headers, bounded retries and pagination over an injected fetch. */
export function createRestClient(options: RestClientOptions): RestClient {
  const { baseUrl, headers, http, retries = 3, backoffMs = (n) => 250 * 2 ** n, sleep = defaultSleep } = options;
  const root = baseUrl.replace(/\/+$/, '');

  async function exchange(method: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
    const init: RequestInit = {
      method,
      headers: { accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let failure: unknown;
      try {
        res = await http(`${root}${path}`, init);
      } catch (err) {
        failure = err;
      }
      if (res?.ok) return { status: res.status, text: await res.text() };
      const transient = res ? retryable(method, res.status) : IDEMPOTENT.has(method);
      if (transient && attempt < retries) {
        await res?.body?.cancel();
        await sleep((res && retryAfterMs(res)) ?? backoffMs(attempt));
        continue;
      }
      if (!res) throw new Error(`${method} ${path} failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      const text = await res.text().catch(() => '');
      throw new RestError(`${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`.trim(), res.status, text, `${method} ${path} failed: ${res.status}`);
    }
  }

  async function request<T>(method: string, path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
    const { status, text } = await exchange(method, path, body);
    let json: unknown;
    try {
      json = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new RestError(`${method} ${path} returned non-JSON: ${text.slice(0, 80)}`, status, text, `${method} ${path} returned non-JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const reason = `${method} ${path} returned an unexpected shape: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 3).join('; ')}`;
      throw new RestError(reason, status, text, reason);
    }
    return parsed.data;
  }

  async function send(method: string, path: string, body?: unknown): Promise<void> {
    await exchange(method, path, body);
  }

  async function paginate<T>(path: string, pageSize: number, item: ZodType<T>, maxPages = 100): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await request('GET', `${path}${sep}page=${page}&limit=${pageSize}`, z.array(item));
      items.push(...batch);
      if (batch.length < pageSize) break;
    }
    return items;
  }

  return { request, send, paginate };
}
