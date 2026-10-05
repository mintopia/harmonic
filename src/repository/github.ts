import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliRunner } from '../tracker/kind.js';
import { pullRequestUrlFromOutput, type RepositoryAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

const defaultGh: CliRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

/** The GitHub Code Repository over ambient `gh` auth; `gh` infers the repo from the checkout's remote. */
export function githubRepository(repoRoot: string, run: CliRunner = defaultGh): RepositoryAdapter {
  return {
    kind: 'github',

    async openPR({ branch, baseBranch, title, body }) {
      const stdout = await run(['pr', 'create', '--head', branch, '--base', baseBranch, '--title', title, '--body', body], repoRoot);
      return pullRequestUrlFromOutput(stdout);
    },

    async verify() {
      try {
        await run(['repo', 'view', '--json', 'nameWithOwner'], repoRoot);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
