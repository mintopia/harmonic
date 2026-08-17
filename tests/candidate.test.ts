import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stubHarness, waitFor, type TestServer } from './helpers.js';
import { buildCandidate, fingerprint, withDetachedWorktree, snapshotCandidate } from '../src/execution/candidate.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

/** A throwaway git repo on branch main with one committed README. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-repo-'));
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** Every local branch's OID, so a test can assert none of them moved. */
function branchOids(dir: string): Record<string, string> {
  const out = git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const result: Record<string, string> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, oid] = line.split(' ');
    if (ref && oid) result[ref] = oid;
  }
  return result;
}

describe('candidate (issue #134)', () => {
  const tmpDirs: string[] = [];
  const tmpPath = (prefix: string) => {
    const p = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(p);
    return p;
  };
  const freshWorktreePath = (prefix: string) => {
    // A worktree path itself must not exist yet — mkdtemp the parent and
    // return a not-yet-existing child path inside it, so callers get an
    // isolated, cleaned-up location without pre-creating the dir git will own.
    const parent = tmpPath(prefix);
    return join(parent, 'wt');
  };

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it('AC1: candidate captures the working tree and parents on the base, without moving the target ref', async () => {
    const repo = makeRepo();
    const baseOid = git(repo, 'rev-parse', 'main');

    // Working-tree changes: modify a tracked file, add an untracked one.
    writeFileSync(join(repo, 'README.md'), '# repo (changed)\n');
    writeFileSync(join(repo, 'newfile.txt'), 'brand new\n');

    const ref = 'refs/harmonic/candidate/run-1';
    const oid = await buildCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: 'main',
      ref,
      message: 'c',
    });

    expect(git(repo, 'rev-parse', `${oid}^`)).toBe(baseOid);
    expect(git(repo, 'show', `${oid}:README.md`)).toBe('# repo (changed)');
    expect(git(repo, 'show', `${oid}:newfile.txt`)).toBe('brand new');
    // The target branch never moved.
    expect(git(repo, 'rev-parse', 'main')).toBe(baseOid);
    // The private ref resolves to the candidate.
    expect(git(repo, 'rev-parse', ref)).toBe(oid);
  });

  it('hermetic: untracked + deleted files are captured, and the real index/worktree are untouched', async () => {
    const repo = makeRepo();
    // A second tracked file to delete.
    writeFileSync(join(repo, 'gone.txt'), 'will be deleted\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add gone.txt');

    unlinkSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, 'untracked.txt'), 'new stuff\n');

    const statusBefore = git(repo, 'status', '--porcelain');

    const ref = 'refs/harmonic/candidate/run-hermetic';
    const oid = await buildCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: 'main',
      ref,
      message: 'c',
    });

    // The candidate tree reflects both the deletion and the untracked file.
    expect(() => git(repo, 'cat-file', '-e', `${oid}:gone.txt`)).toThrow();
    expect(git(repo, 'show', `${oid}:untracked.txt`)).toBe('new stuff');

    // The workspace's real status/index are unaffected by the build.
    const statusAfter = git(repo, 'status', '--porcelain');
    expect(statusAfter).toBe(statusBefore);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('AC5: never moves the target ref — every branch OID is unchanged, only the private ref is new', async () => {
    const repo = makeRepo();
    // A second branch, to prove buildCandidate doesn't touch any branch, not
    // just the current one.
    git(repo, 'branch', 'other');

    const before = branchOids(repo);
    writeFileSync(join(repo, 'README.md'), '# repo (changed again)\n');

    const ref = 'refs/harmonic/candidate/run-ac5';
    await buildCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: 'main',
      ref,
      message: 'c',
    });

    const after = branchOids(repo);
    expect(after).toEqual(before);
    // Only the private candidate ref is new.
    expect(git(repo, 'rev-parse', ref)).toBeTruthy();
  });

  it('buildCandidate is CAS-create: a second build to the same existing ref rejects', async () => {
    const repo = makeRepo();
    const ref = 'refs/harmonic/candidate/run-cas';
    await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'first' });

    writeFileSync(join(repo, 'README.md'), '# repo (second attempt)\n');
    await expect(
      buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'second' }),
    ).rejects.toThrow();
  });

  it('AC2: the disposable detached worktree is removed after use, and was detached with the candidate OID checked out while alive', async () => {
    const repo = makeRepo();
    const ref = 'refs/harmonic/candidate/run-detach';
    const oid = await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'c' });

    const wtPath = freshWorktreePath('harmonic-wt-');
    let sawDetachedDuringRun = false;
    let headOidDuringRun = '';

    await withDetachedWorktree(repo, oid, wtPath, async (dir) => {
      expect(existsSync(dir)).toBe(true);
      expect(() => git(dir, 'symbolic-ref', '-q', 'HEAD')).toThrow();
      sawDetachedDuringRun = true;
      headOidDuringRun = git(dir, 'rev-parse', 'HEAD');
    });

    expect(sawDetachedDuringRun).toBe(true);
    expect(headOidDuringRun).toBe(oid);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('AC2: the worktree is removed even when fn throws', async () => {
    const repo = makeRepo();
    const ref = 'refs/harmonic/candidate/run-throw';
    const oid = await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'c' });

    const wtPath = freshWorktreePath('harmonic-wt-throw-');

    await expect(
      withDetachedWorktree(repo, oid, wtPath, async () => {
        throw new Error('verifier blew up');
      }),
    ).rejects.toThrow('verifier blew up');

    expect(existsSync(wtPath)).toBe(false);
  });

  it('AC3: before/after fingerprint detects a verifier that mutated the tree, and stays stable for a no-op', async () => {
    const repo = makeRepo();
    const ref = 'refs/harmonic/candidate/run-fp-tree';
    const oid = await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'c' });

    // No-op verifier: fingerprint unchanged.
    const noopPath = freshWorktreePath('harmonic-wt-noop-');
    const noopProof = await withDetachedWorktree(repo, oid, noopPath, async () => {});
    expect(noopProof.mutated).toBe(false);
    expect(noopProof.before).toBe(noopProof.after);

    // A verifier that writes a file: fingerprint changes (tree half).
    const mutatePath = freshWorktreePath('harmonic-wt-mutate-');
    const mutateProof = await withDetachedWorktree(repo, oid, mutatePath, async (dir) => {
      writeFileSync(join(dir, 'mutated-by-verifier.txt'), 'oops\n');
    });
    expect(mutateProof.mutated).toBe(true);
    expect(mutateProof.before).not.toBe(mutateProof.after);
  });

  it('AC3: a verifier that creates a new ref also flips mutated (the ref half of the fingerprint)', async () => {
    const repo = makeRepo();
    const ref = 'refs/harmonic/candidate/run-fp-ref';
    const oid = await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'c' });

    const wtPath = freshWorktreePath('harmonic-wt-newref-');
    const proof = await withDetachedWorktree(repo, oid, wtPath, async () => {
      // A ref a real verifier might create — NOT under refs/harmonic/*, which
      // the fingerprint deliberately excludes (Harmonic pins candidate refs
      // concurrently, so those must not count as a verifier mutation).
      git(repo, 'update-ref', 'refs/tags/verifier-sideeffect', oid);
    });
    expect(proof.mutated).toBe(true);
  });

  it('a concurrent refs/harmonic/* ref does NOT flip mutated (excluded from the fingerprint)', async () => {
    const repo = makeRepo();
    const ref = 'refs/harmonic/candidate/run-fp-conc';
    const oid = await buildCandidate({ repoDir: repo, workspaceDir: repo, baseRev: 'main', ref, message: 'c' });

    const wtPath = freshWorktreePath('harmonic-wt-conc-');
    const proof = await withDetachedWorktree(repo, oid, wtPath, async () => {
      // Simulate another Run pinning its own candidate ref mid-verification —
      // this is Harmonic's own bookkeeping, not a verifier mutation.
      git(repo, 'update-ref', 'refs/harmonic/candidate/run-999', oid);
    });
    expect(proof.mutated).toBe(false);
  });

  it('fingerprint is stable across repeated calls when nothing changed', async () => {
    const repo = makeRepo();
    const first = await fingerprint(repo, repo);
    const second = await fingerprint(repo, repo);
    expect(first).toBe(second);
  });

  it('AC4: a dirty direct context yields no candidate', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), '# dirty\n');

    const ref = 'refs/harmonic/candidate/run-dirty';
    const wtPath = freshWorktreePath('harmonic-wt-dirty-');
    const result = await snapshotCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: 'main',
      ref,
      message: 'c',
      isolationMode: 'direct',
      startDirty: true,
      worktreePath: wtPath,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'dirty-direct-context' });
    // No candidate ref was created.
    expect(() => git(repo, 'rev-parse', ref)).toThrow();
  });

  it('snapshotCandidate happy path (worktree mode): created, private ref exists, target branch unchanged, verify worktree cleaned up', async () => {
    const repo = makeRepo();
    const baseOid = git(repo, 'rev-parse', 'main');
    writeFileSync(join(repo, 'README.md'), '# worktree-mode change\n');

    const ref = 'refs/harmonic/candidate/run-happy';
    const wtPath = freshWorktreePath('harmonic-wt-happy-');
    const result = await snapshotCandidate({
      repoDir: repo,
      workspaceDir: repo,
      baseRev: 'main',
      ref,
      message: 'c',
      isolationMode: 'worktree',
      startDirty: false,
      worktreePath: wtPath,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') throw new Error('unreachable');
    expect(result.ref).toBe(ref);
    expect(result.mutated).toBe(false);
    expect(git(repo, 'rev-parse', ref)).toBe(result.oid);
    expect(git(repo, 'rev-parse', 'main')).toBe(baseOid);
    expect(existsSync(wtPath)).toBe(false);
  });
});

describe('candidate integration: Runner freezes a candidate onto the Run row (issue #134)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(stubHarness());
  });
  afterAll(async () => {
    await server.close();
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-repo-'));
    execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(dir, 'README.md'), '# repo\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    return dir;
  }

  it('a worktree Run reaching awaiting-review has a 40-hex candidateOid, and the base branch is unchanged', async () => {
    const repo = makeRepo();
    const baseOidBefore = git(repo, 'rev-parse', 'main');

    const created = await server.api('POST', '/api/tasks', {
      prompt: JSON.stringify({ writeFiles: { 'feature.txt': 'made by agent\n' } }),
      workingDir: repo,
      isolationMode: 'worktree',
    });
    const started = await server.api('POST', `/api/tasks/${created.body.id}/run`);
    await waitFor(
      async () => (await server.api('GET', `/api/tasks/${created.body.id}`)).body.state === 'awaiting-review',
    );

    const run = (await server.api('GET', `/api/runs/${started.body.id}`)).body;
    expect(run.candidateOid).toMatch(/^[0-9a-f]{40}$/);
    expect(run.candidateRef).toBeTruthy();

    expect(git(repo, 'rev-parse', 'main')).toBe(baseOidBefore);
  });
});
