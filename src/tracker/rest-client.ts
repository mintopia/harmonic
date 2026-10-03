import type { TrackerHttp } from './kind.js';

export class RestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'RestError';
  }
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
  /** One request; resolves the parsed JSON body, or `undefined` for an empty body. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Every item of a page-numbered list endpoint, stopping at the first short page. */
  paginate<T>(path: string, pageSize: number, maxPages?: number): Promise<T[]>;
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

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      if (res?.ok) {
        const text = await res.text();
        return (text.trim() ? JSON.parse(text) : undefined) as T;
      }
      const transient = res ? retryable(method, res.status) : IDEMPOTENT.has(method);
      if (transient && attempt < retries) {
        await sleep((res && retryAfterMs(res)) ?? backoffMs(attempt));
        continue;
      }
      if (!res) throw new Error(`${method} ${path} failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      const text = await res.text().catch(() => '');
      throw new RestError(`${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`.trim(), res.status, text);
    }
  }

  async function paginate<T>(path: string, pageSize: number, maxPages = 100): Promise<T[]> {
    const sep = path.includes('?') ? '&' : '?';
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await request<T[]>('GET', `${path}${sep}page=${page}&limit=${pageSize}`);
      items.push(...batch);
      if (batch.length < pageSize) break;
    }
    return items;
  }

  return { request, paginate };
}
