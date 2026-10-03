import { parseRemote } from './remote.js';

/** The hosts a Code Repository can live on. */
export type RepositoryKind = 'github' | 'gitlab' | 'forgejo' | 'git';

/** Whether `host` answers a Forgejo `/api/v1/version` request. */
export type ForgejoProbe = (host: string) => Promise<boolean>;

/** The hostname of a git remote URL (`https://`, `ssh://` or scp-style `git@host:path`), lowercased. */
export function remoteHost(remoteUrl: string): string | null {
  return parseRemote(remoteUrl)?.host ?? null;
}

/** Detect the Code Repository kind from an `origin` remote URL: github.com, gitlab.com, else Forgejo when the host answers the probe. */
export async function detectRepository(remoteUrl: string, probe: ForgejoProbe): Promise<RepositoryKind | null> {
  const host = remoteHost(remoteUrl);
  if (!host) return null;
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  return (await probe(host)) ? 'forgejo' : null;
}

/** A {@link ForgejoProbe} that GETs `https://<host>/api/v1/version` and treats a 2xx JSON `version` as Forgejo. */
export function forgejoVersionProbe(fetchFn: typeof fetch = fetch, timeoutMs = 3000): ForgejoProbe {
  return async (host) => {
    try {
      const res = await fetchFn(`https://${host}/api/v1/version`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      const body: unknown = await res.json();
      return typeof body === 'object' && body !== null && typeof (body as { version?: unknown }).version === 'string';
    } catch {
      return false;
    }
  };
}

/** Remembers each host's probe answer for `ttlMs`, so repeated resolution never re-hits the network. */
export function cachedProbe(probe: ForgejoProbe, ttlMs = 5 * 60_000, now: () => number = Date.now): ForgejoProbe {
  const answers = new Map<string, { at: number; result: boolean }>();
  return async (host) => {
    const hit = answers.get(host);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    const result = await probe(host);
    answers.set(host, { at: now(), result });
    return result;
  };
}
