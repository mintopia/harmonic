import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workContextKey } from '../src/domain/work-context-key.js';
import { DomainError } from '../src/domain/errors.js';

describe('workContextKey (issue #118, ADR-0022)', () => {
  it('direct mode: two calls with the same workingDir but different branch produce the same key', () => {
    const a = workContextKey({ isolationMode: 'direct', workingDir: '/tmp/some-repo', branch: 'feature/a' });
    const b = workContextKey({ isolationMode: 'direct', workingDir: '/tmp/some-repo', branch: 'feature/b' });
    expect(a).toBe(b);
  });

  it('worktree mode: two calls with different {path, branch} produce different keys', () => {
    const a = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-a', branch: 'feature/a' });
    const b = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-b', branch: 'feature/b' });
    expect(a).not.toBe(b);
  });

  it('worktree mode: same {path, branch} produces the same key', () => {
    const a = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-a', branch: 'feature/a' });
    const b = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-a', branch: 'feature/a' });
    expect(a).toBe(b);
  });

  it('worktree mode: distinct branches on the same worktree path still produce different keys', () => {
    const a = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-a', branch: 'feature/a' });
    const b = workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-a', branch: 'feature/c' });
    expect(a).not.toBe(b);
  });

  describe('canonicalisation stability', () => {
    it('trailing slash, "." and duplicate slashes on the same real dir all produce the same direct-mode key', () => {
      const dir = mkdtempSync(join(tmpdir(), 'harmonic-wck-'));
      const real = realpathSync(dir);

      const base = workContextKey({ isolationMode: 'direct', workingDir: dir });
      const trailingSlash = workContextKey({ isolationMode: 'direct', workingDir: `${dir}/` });
      const dotSegment = workContextKey({ isolationMode: 'direct', workingDir: `${dir}/.` });
      const dupSlashes = workContextKey({ isolationMode: 'direct', workingDir: dir.replace(/\//g, '//') });

      expect(base).toBe(`direct:${real}`);
      expect(trailingSlash).toBe(base);
      expect(dotSegment).toBe(base);
      expect(dupSlashes).toBe(base);

      rmSync(dir, { recursive: true, force: true });
    });
  });

  it('worktree mode without a branch throws DomainError(validation)', () => {
    expect(() => workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', worktreePath: '/tmp/wt-a' })).toThrow(
      DomainError,
    );
  });

  it('worktree mode without a worktreePath throws DomainError(validation)', () => {
    expect(() => workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x', branch: 'feature/a' })).toThrow(
      DomainError,
    );
  });

  it('worktree mode missing both throws with code "validation"', () => {
    let caught: unknown;
    try {
      workContextKey({ isolationMode: 'worktree', workingDir: '/tmp/x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe('validation');
  });
});
