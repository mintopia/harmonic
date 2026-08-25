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

  it('reports mutations to the detached checkout', async () => {
    const repo = makeRepo();
    const proof = await withDetachedWorktree(
      repo,
      git(repo, 'rev-parse', 'HEAD'),
      join(repo, '.harmonic-verification'),
      async (checkout) => {
        writeFileSync(join(checkout, 'generated.txt'), 'generated\n');
        return 'done';
      },
    );

    expect(proof.result).toBe('done');
    expect(proof.mutated).toBe(true);
    expect(proof.before).not.toBe(proof.after);
  });

  it('excludes Harmonic private refs from the mutation fingerprint', async () => {
    const repo = makeRepo();
    const proof = await withDetachedWorktree(
      repo,
      git(repo, 'rev-parse', 'HEAD'),
      join(repo, '.harmonic-verification'),
      async () => {
        git(repo, 'update-ref', 'refs/harmonic/test-verifier', 'HEAD');
        return undefined;
      },
    );

    expect(proof.mutated).toBe(false);
    expect(proof.before).toBe(proof.after);
  });
});
