import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepositoryAdapter } from './adapter.js';
import { detectRepository, forgejoVersionProbe, type ForgejoProbe, type RepositoryKind } from './detect.js';
import { githubRepository } from './github.js';

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

/** The repo's Code Repository adapter; null when its kind has no adapter yet (only GitHub does). */
export async function resolveRepositoryAdapter(repoRoot: string, override?: RepositoryKind | null): Promise<RepositoryAdapter | null> {
  const kind = await resolveCodeRepository(repoRoot, override, async () => false);
  return kind === 'github' ? githubRepository(repoRoot) : null;
}
