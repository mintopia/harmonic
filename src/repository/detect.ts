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

/** Whether `host` is a loopback, private, link-local or otherwise non-public address that the probe must never contact. */
export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase();
  const bracketed = /^\[([^\]]*)\]/.exec(lower);
  const h = bracketed ? bracketed[1]! : lower.split(':').length === 2 ? lower.split(':')[0]! : lower;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^(fc|fd|fe[89ab])/.test(h) || h.startsWith('::ffff:');
  return false;
}

/** A {@link ForgejoProbe} that GETs `https://<host>/api/v1/version` and treats a 2xx JSON `version` as Forgejo. */
export function forgejoVersionProbe(fetchFn: typeof fetch = fetch, timeoutMs = 3000): ForgejoProbe {
  return async (host) => {
    if (host === 'github.com' || host === 'gitlab.com' || isPrivateHost(host)) return false;
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
