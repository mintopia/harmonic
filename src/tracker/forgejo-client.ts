import { z } from 'zod';
import { parseRemote } from '../repository/remote.js';
import { createRestClient, safeErrorReason, type RestClient } from './rest-client.js';
import type { TrackerHttp } from './kind.js';

/** The Secret that holds a Forgejo access token unless settings name another. */
export const FORGEJO_TOKEN_SECRET = 'FORGEJO_TOKEN';

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

const userSchema = z.object({ login: z.string().optional() });

/** Verifies the token by asking who it belongs to (`GET /api/v1/user`). */
export async function verifyForgejoToken(client: RestClient): Promise<ForgejoVerifyResult> {
  try {
    const user = await client.request('GET', '/user', userSchema);
    return user.login ? { ok: true, login: user.login } : { ok: false, reason: 'Forgejo returned no user for this token' };
  } catch (err) {
    return { ok: false, reason: safeErrorReason(err) };
  }
}

/** The instance root and `owner/name` of a git remote URL, or null when it names no repo. http(s) remotes keep their scheme and port; ssh and scp-style remotes address the web UI over https. */
export function parseForgejoRemote(remoteUrl: string): { baseUrl: string; repo: string } | null {
  const remote = parseRemote(remoteUrl);
  if (!remote?.repo) return null;
  const web = remote.scheme === 'http' || remote.scheme === 'https';
  const origin = `${web ? remote.scheme : 'https'}://${remote.host}${web && remote.port ? `:${remote.port}` : ''}`;
  return { baseUrl: origin, repo: remote.repo };
}
