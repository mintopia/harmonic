import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliRunner } from '../tracker/kind.js';
import type { RepositoryAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

const defaultGit: CliRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};

/** The generic Code Repository for hosts with no hosting API: opening a PR just pushes the branch to `origin`. */
export function gitRepository(repoRoot: string, run: CliRunner = defaultGit): RepositoryAdapter {
  return {
    kind: 'git',

    async openPR({ branch }) {
      if (branch.startsWith('-')) throw new Error(`Invalid branch name: ${branch}`);
      await run(['push', 'origin', '--', branch], repoRoot);
      return null;
    },

    async verify() {
      try {
        await run(['ls-remote', '--exit-code', 'origin', 'HEAD'], repoRoot);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
