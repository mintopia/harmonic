import { createRestClient, type RestClient } from './rest-client.js';
import type { TrackerHttp } from './kind.js';

export interface ForgejoConnection {
  /** Instance root, e.g. `https://forge.example` (no `/api/v1`). */
  baseUrl: string;
  token: string;
  http: TrackerHttp;
}

/** A REST client for one Forgejo instance, authenticated with an access token. */
export function forgejoClient({ baseUrl, token, http }: ForgejoConnection): RestClient {
  return createRestClient({
    baseUrl: `${baseUrl.replace(/\/+$/, '')}/api/v1`,
    headers: { authorization: `token ${token}` },
    http,
  });
}

/** The `owner/name` path segments of a repo, URL-escaped for an API path. */
export function repoPath(repo: string): string {
  return repo.split('/').map(encodeURIComponent).join('/');
}

export type ForgejoVerifyResult = { ok: true; login: string } | { ok: false; reason: string };

/** Verifies the token by asking who it belongs to (`GET /api/v1/user`). */
export async function verifyForgejoToken(client: RestClient): Promise<ForgejoVerifyResult> {
  try {
    const user = await client.request<{ login?: string }>('GET', '/user');
    return user?.login ? { ok: true, login: user.login } : { ok: false, reason: 'Forgejo returned no user for this token' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The instance root and `owner/name` of a git remote URL, or null when it names no repo. */
export function parseForgejoRemote(remoteUrl: string): { baseUrl: string; repo: string } | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return m ? { baseUrl: `https://${m[1]!.toLowerCase()}`, repo: m[2]! } : null;
}
