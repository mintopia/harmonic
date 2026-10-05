import { parseRemote } from './remote.js';

/** The hosts a Code Repository can live on. */
export type RepositoryKind = 'github' | 'gitlab' | 'forgejo' | 'git';

/** Where a remote's web UI lives: its host, plus the port and http scheme when the remote URL was an http(s) one that named them. */
export interface ProbeTarget {
  host: string;
  port: number | null;
  scheme: 'http' | 'https';
}

/** Whether `target` answers a Forgejo `/api/v1/version` request. */
export type ForgejoProbe = (target: ProbeTarget) => Promise<boolean>;

/** The hostname of a git remote URL (`https://`, `ssh://` or scp-style `git@host:path`), lowercased. */
export function remoteHost(remoteUrl: string): string | null {
  return parseRemote(remoteUrl)?.host ?? null;
}

/** Detect the Code Repository kind from an `origin` remote URL: github.com, gitlab.com, else Forgejo, then GitLab, when the host answers its probe. */
export async function detectRepository(remoteUrl: string, probe: ForgejoProbe, gitlab: ForgejoProbe = async () => false): Promise<RepositoryKind | null> {
  const remote = parseRemote(remoteUrl);
  if (!remote) return null;
  const { host } = remote;
  if (host === 'github.com') return 'github';
  if (host === 'gitlab.com') return 'gitlab';
  const web = remote.scheme === 'http' || remote.scheme === 'https';
  const target: ProbeTarget = { host, port: web ? remote.port : null, scheme: remote.scheme === 'http' ? 'http' : 'https' };
  if (await probe(target)) return 'forgejo';
  return (await gitlab(target)) ? 'gitlab' : null;
}

async function probeJson(fetchFn: typeof fetch, timeoutMs: number, { host, port, scheme }: ProbeTarget, path: string): Promise<unknown> {
  try {
    const authority = port === null ? host : `${host}:${port}`;
    const res = await fetchFn(`${scheme}://${authority}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const field = (body: unknown, key: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined);

/** A {@link ForgejoProbe} that GETs `<scheme>://<host>[:port]/api/v1/version` and treats a 2xx JSON `version` as Forgejo. A redirect is never followed and counts as not Forgejo. */
export function forgejoVersionProbe(fetchFn: typeof fetch = fetch, timeoutMs = 3000): ForgejoProbe {
  return async (target) => typeof field(await probeJson(fetchFn, timeoutMs, target, '/api/v1/version'), 'version') === 'string';
}

/** A probe that recognises a self-hosted GitLab by its public, unauthenticated web manifest (`/-/manifest.json`, named "GitLab"); the version API needs a token. */
export function gitlabProbe(fetchFn: typeof fetch = fetch, timeoutMs = 3000): ForgejoProbe {
  return async (target) => field(await probeJson(fetchFn, timeoutMs, target, '/-/manifest.json'), 'name') === 'GitLab';
}

/** Remembers each host's probe answer for `ttlMs`, so repeated resolution never re-hits the network. */
export function cachedProbe(probe: ForgejoProbe, ttlMs = 5 * 60_000, now: () => number = Date.now): ForgejoProbe {
  const answers = new Map<string, { at: number; result: boolean }>();
  return async (target) => {
    const key = `${target.scheme}://${target.host}:${target.port ?? ''}`;
    const hit = answers.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.result;
    const result = await probe(target);
    answers.set(key, { at: now(), result });
    return result;
  };
}
