import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyEpicIntegration } from '../src/execution/epic-verification.js';

describe('verifyEpicIntegration', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('runs ordered commands and every critic in the live Epic worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harmonic-epic-verify-'));
    directories.push(root);
    const repoDir = join(root, 'repo');
    const worktreePath = join(root, 'epic');
    const git = (...args: string[]) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-b', 'develop', repoDir], { encoding: 'utf8' });
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    git('add', '-A');
    git('commit', '-m', 'base');
    git('branch', 'epic/526');
    git('worktree', 'add', worktreePath, 'epic/526');
    writeFileSync(join(worktreePath, 'epic-only.txt'), 'present\n');
    execFileSync('git', ['-C', worktreePath, 'add', '-A'], { encoding: 'utf8' });
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'epic work'], { encoding: 'utf8' });
    const verifiedHeadOid = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const critic = vi.fn(async ({ cwd }: { cwd: string }) => {
      expect(cwd).toBe(worktreePath);
      return { verifier: 'critic' as const, verdict: 'pass' as const };
    });

    await expect(verifyEpicIntegration({
      worktreePath,
      verifiedHeadOid,
      verifiers: {
        commands: [{
          command: process.execPath,
          args: ['-e', `if (process.cwd() !== ${JSON.stringify(worktreePath)}) process.exit(1)`],
          env: {},
          timeoutSeconds: 10,
        }],
        critics: [
          { name: 'Test critic', prompt: 'Review the Epic.', model: 'stub-model' },
          { name: 'Test critic', prompt: 'Review the integration.', model: 'stub-model' },
        ],
      },
      runCritic: critic,
    })).resolves.toEqual({ outcome: 'proceed', reason: 'all 3 verifiers passed' });

    expect(critic).toHaveBeenCalledTimes(2);
  });

  it('retains every critic summary and raw output for the resolver', async () => {
    await expect(verifyEpicIntegration({
      worktreePath: '/epic-worktree',
      verifiedHeadOid: 'epic-head',
      verifiers: {
        commands: [],
        critics: [
          { name: 'Test critic', prompt: 'Review the migration.', model: 'stub-model' },
          { name: 'Test critic', prompt: 'Review the Epic.', model: 'stub-model' },
        ],
      },
      runCritic: vi.fn()
        .mockResolvedValueOnce({
          verifier: 'critic',
          verdict: 'pass',
          summary: 'The migration is correct.',
          output: 'No migration issue found.',
        })
        .mockResolvedValueOnce({
          verifier: 'critic',
          verdict: 'fail',
          summary: 'The integration omits the migration.',
          output: 'Found a missing migration in src/db/schema.ts.',
        }),
    })).resolves.toEqual({
      outcome: 'block',
      reason: 'verifier critic failed\n\n' +
        'Epic critic 1 (pass): The migration is correct.\n' +
        'No migration issue found.\n\n' +
        'Epic critic 2 (fail): The integration omits the migration.\n' +
        'Found a missing migration in src/db/schema.ts.',
    });
  });

  it('retains failed command output for the resolver', async () => {
    const recorded = vi.fn();
    await expect(verifyEpicIntegration({
      worktreePath: process.cwd(),
      verifiedHeadOid: 'epic-head',
      verifiers: {
        commands: [{
          command: process.execPath,
          args: ['-e', 'console.error("missing migration"); process.exit(1)'],
          env: {},
          timeoutSeconds: 10,
        }],
        critics: [],
      },
      runCritic: vi.fn(),
      onCommand: recorded,
    })).resolves.toEqual({
      outcome: 'block',
      reason: 'verifier command failed\n\nEpic command (fail): command exited 1\nmissing migration\n',
    });
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({
      verifier: 'command',
      verdict: 'fail',
      output: 'missing migration\n',
    }), expect.objectContaining({ command: process.execPath }));
  });
});
