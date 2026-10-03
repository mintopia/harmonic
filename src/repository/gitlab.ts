import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliRunner } from '../tracker/kind.js';
import { pullRequestUrlFromOutput, type RepositoryAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

const defaultGlab: CliRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('glab', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

/** The GitLab Code Repository over ambient `glab` auth; `glab` infers host and project from the checkout's remote, so self-hosted works. */
export function gitlabRepository(repoRoot: string, run: CliRunner = defaultGlab): RepositoryAdapter {
  return {
    kind: 'gitlab',

    async openPR({ branch, baseBranch, title, body }) {
      const stdout = await run(
        ['mr', 'create', '--source-branch', branch, '--target-branch', baseBranch, '--title', title, '--description', body, '--yes'],
        repoRoot,
      );
      return pullRequestUrlFromOutput(stdout);
    },

    async verify() {
      try {
        await run(['repo', 'view'], repoRoot);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
