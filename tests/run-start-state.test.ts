import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/execution/git.js';
import { DEFAULT_DRIVE_PROMPT } from '../src/config.js';
import {
  evaluateAdmission,
  type StartStateProbe,
} from '../src/domain/run-start-state.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-startstate-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

const HEX40 = /^[0-9a-f]{40}$/;

/** A clean, on-branch probe; individual tests override the fields under test. */
function cleanProbe(overrides: Partial<StartStateProbe> = {}): StartStateProbe {
  return {
    repoIdentity: { root: '/repo', remote: null },
    headOid: 'a'.repeat(40),
    branch: 'main',
    dirty: false,
    dirtyFingerprint: 'fp',
    submodules: false,
    nestedRepos: false,
    worktreePath: '/repo',
    ...overrides,
  };
}

describe('evaluateAdmission (issue #149, pure gate)', () => {
  it('admits a clean on-branch context and records the full start-state', () => {
    const probe = cleanProbe({ headOid: 'b'.repeat(40), branch: 'develop', worktreePath: '/work' });
    const result = evaluateAdmission(probe);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startState).toMatchObject({
      startBranch: 'develop',
      startCommit: 'b'.repeat(40),
      worktreePath: '/work',
      dirtyFingerprint: 'fp',
      repoIdentity: { root: '/repo', remote: null },
    });
    // A non-detached admission never carries a landingBranch.
    expect(result.startState.landingBranch).toBeUndefined();
  });

  it('rejects a dirty context with a clean-context reason', () => {
    const result = evaluateAdmission(cleanProbe({ dirty: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/dirty|uncommitted|clean context/i);
  });

  it('rejects a context containing submodules', () => {
    const result = evaluateAdmission(cleanProbe({ submodules: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/submodule/i);
  });

  it('rejects a context containing a nested repository', () => {
    const result = evaluateAdmission(cleanProbe({ nestedRepos: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/nested/i);
  });

  it('reports the nested-repo reason ahead of dirty (a nested repo also reads as dirty)', () => {
    const result = evaluateAdmission(cleanProbe({ nestedRepos: true, dirty: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/nested/i);
  });

  it('rejects a detached HEAD when no landing branch is supplied', () => {
    const result = evaluateAdmission(cleanProbe({ branch: null }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/detached/i);
  });

  it('admits a detached HEAD with an operator landing branch, recording the commit — never "HEAD"', () => {
    const probe = cleanProbe({ branch: null, headOid: 'c'.repeat(40) });
    const result = evaluateAdmission(probe, 'release/1.0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startState.startBranch).toBe('release/1.0');
    expect(result.startState.landingBranch).toBe('release/1.0');
    // The recorded commit is the real OID, and the branch is never the literal HEAD.
    expect(result.startState.startCommit).toBe('c'.repeat(40));
    expect(result.startState.startBranch).not.toBe('HEAD');
  });

  it('ignores a landing branch when already on a real branch', () => {
    const result = evaluateAdmission(cleanProbe({ branch: 'main' }), 'release/1.0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startState.startBranch).toBe('main');
    expect(result.startState.landingBranch).toBeUndefined();
  });
});

describe('drive prompt (issue #149, belt-and-suspenders)', () => {
  it('tells the agent Harmonic owns branching', () => {
    expect(DEFAULT_DRIVE_PROMPT).toMatch(/owns branching/i);
    expect(DEFAULT_DRIVE_PROMPT).toMatch(/do not create, switch, or delete git branches/i);
  });
});

describe('Git start-state probes (issue #149)', () => {
  it('symbolicBranch returns the branch, or null on a detached HEAD (never "HEAD")', async () => {
    const repo = makeRepo();
    try {
      expect(await Git.symbolicBranch(repo)).toBe('main');
      git(repo, 'checkout', '--detach', 'HEAD');
      expect(await Git.symbolicBranch(repo)).toBeNull();
      // The legacy helper conflates the two — this is exactly why symbolicBranch exists.
      expect(await Git.currentBranch(repo)).toBe('HEAD');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('revParse returns the 40-hex HEAD OID', async () => {
    const repo = makeRepo();
    try {
      expect(await Git.revParse(repo, 'HEAD')).toMatch(HEX40);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('statusFingerprint is stable while clean and moves when the tree changes', async () => {
    const repo = makeRepo();
    try {
      const a = await Git.statusFingerprint(repo);
      const b = await Git.statusFingerprint(repo);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(repo, 'new.txt'), 'x\n');
      expect(await Git.statusFingerprint(repo)).not.toBe(a);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('hasSubmodules is false on a plain repo and true once a .gitmodules exists', async () => {
    const repo = makeRepo();
    try {
      expect(await Git.hasSubmodules(repo)).toBe(false);
      writeFileSync(join(repo, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
      expect(await Git.hasSubmodules(repo)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('hasNestedRepos is false on a plain repo, false for a plain untracked dir, true for a nested git repo', async () => {
    const repo = makeRepo();
    try {
      expect(await Git.hasNestedRepos(repo)).toBe(false);

      // A plain untracked directory is not a repo.
      mkdirSync(join(repo, 'plaindir'));
      writeFileSync(join(repo, 'plaindir', 'a.txt'), 'a\n');
      expect(await Git.hasNestedRepos(repo)).toBe(false);

      // An independent git repo checked out inside the tree is detected.
      const nested = join(repo, 'nested');
      mkdirSync(nested);
      execFileSync('git', ['init', nested], { encoding: 'utf8' });
      expect(await Git.hasNestedRepos(repo)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('toplevel resolves the repo root and originUrl is null without an origin', async () => {
    const repo = makeRepo();
    try {
      expect(realpathSync(await Git.toplevel(repo))).toBe(realpathSync(repo));
      expect(await Git.originUrl(repo)).toBeNull();
      git(repo, 'remote', 'add', 'origin', 'https://example.com/x.git');
      expect(await Git.originUrl(repo)).toBe('https://example.com/x.git');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('toplevel rejects on a non-git directory (so the Runner records no start-state there)', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'harmonic-plain-'));
    try {
      await expect(Git.toplevel(plain)).rejects.toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
