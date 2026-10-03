import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepositoryAdapter } from './adapter.js';
import { detectRepository, forgejoVersionProbe, type ForgejoProbe, type RepositoryKind } from './detect.js';
import { forgejoRepository } from './forgejo.js';
import { githubRepository } from './github.js';
import { parseForgejoRemote, type ForgejoConnection } from '../tracker/forgejo-client.js';

const execFileAsync = promisify(execFile);

/** The repo's Code Repository kind: the Workspace override, else detected from its `origin` remote; null when neither names one. */
export async function resolveCodeRepository(
  repoRoot: string,
  override?: RepositoryKind | null,
  probe: ForgejoProbe = forgejoVersionProbe(),
): Promise<RepositoryKind | null> {
  if (override) return override;
  let url: string;
  try {
    url = (await execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'])).stdout.trim();
  } catch {
    return null;
  }
  return detectRepository(url, probe);
}

/** Forgejo needs a token (a Secret), so its adapter is built only when the caller supplies one. */
export type ForgejoCredentials = Pick<ForgejoConnection, 'token' | 'http'>;

/** The repo's Code Repository adapter; null when its kind is unresolved or has no adapter (GitLab). */
export async function resolveRepositoryAdapter(
  repoRoot: string,
  override?: RepositoryKind | null,
  forgejo?: ForgejoCredentials,
): Promise<RepositoryAdapter | null> {
  const kind = await resolveCodeRepository(repoRoot, override, async () => false);
  if (kind === 'github') return githubRepository(repoRoot);
  if (kind === 'forgejo' && forgejo) {
    const remote = await execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']).then(
      (r) => parseForgejoRemote(r.stdout),
      () => null,
    );
    return remote ? forgejoRepository({ ...remote, ...forgejo }) : null;
  }
  return null;
}
