import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDetachedWorktree } from '../src/execution/detached-worktree.js';

const tmpDirs: string[] = [];

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-detached-worktree-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('withDetachedWorktree', () => {
  it('removes its disposable checkout when the verifier throws', async () => {
    const repo = makeRepo();
    const checkout = join(repo, '.harmonic-verification');

    await expect(
      withDetachedWorktree(repo, git(repo, 'rev-parse', 'HEAD'), checkout, async () => {
        throw new Error('verifier failed');
      }),
    ).rejects.toThrow('verifier failed');

    expect(existsSync(checkout)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(checkout);
  });

  it('returns the verifier result and removes the checkout when it resolves', async () => {
    const repo = makeRepo();
    const checkout = join(repo, '.harmonic-verification');

    const result = await withDetachedWorktree(
      repo,
      git(repo, 'rev-parse', 'HEAD'),
      checkout,
      async (dir) => {
        expect(existsSync(join(dir, 'README.md'))).toBe(true);
        return 'done';
      },
    );

    expect(result).toBe('done');
    expect(existsSync(checkout)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(checkout);
  });
});
