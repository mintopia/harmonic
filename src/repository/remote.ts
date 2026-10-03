import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitRemote {
  /** URL scheme, lowercased; `null` for scp-style `git@host:path`. */
  scheme: string | null;
  host: string;
  port: number | null;
  /** `owner/name` with any `.git` suffix removed; `null` when the URL names no repo. */
  repo: string | null;
}

const REMOTE =
  /^(?:(?<scheme>[a-z][a-z0-9+.-]*):\/\/)?(?:[^@/\s]+@)?(?<host>[^:/\s]+)(?::(?<port>\d+))?(?:[:/]+(?<path>\S*))?$/i;
const OWNER_NAME = /^[^/]+\/[^/]+$/;

/** Parses an `https://`, `ssh://` or scp-style git remote URL; null when it has no host. */
export function parseRemote(remoteUrl: string): GitRemote | null {
  const groups = REMOTE.exec(remoteUrl.trim())?.groups;
  if (!groups?.host) return null;
  const path = (groups.path ?? '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return {
    scheme: groups.scheme?.toLowerCase() ?? null,
    host: groups.host.toLowerCase(),
    port: groups.port ? Number(groups.port) : null,
    repo: OWNER_NAME.test(path) ? path : null,
  };
}

/** Reads the repo's `origin` remote URL once, on first call; null when there is none. */
export function originRemote(repoRoot: string): () => Promise<string | null> {
  let pending: Promise<string | null> | undefined;
  return () =>
    (pending ??= execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']).then(
      (r) => r.stdout.trim(),
      () => null,
    ));
}
