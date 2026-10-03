import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepositoryAdapter } from './adapter.js';
import { githubRepository } from './github.js';

const execFileAsync = promisify(execFile);

/** The repo's Code Repository, detected from its `origin` remote; null when the host has no repository adapter. */
export async function resolveRepositoryAdapter(repoRoot: string): Promise<RepositoryAdapter | null> {
  let url: string;
  try {
    url = (await execFileAsync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'])).stdout.trim();
  } catch {
    return null;
  }
  return /^(?:git@|(?:https?|ssh):\/\/(?:[^@/]+@)?)github\.com[:/]/.test(url) ? githubRepository(repoRoot) : null;
}
