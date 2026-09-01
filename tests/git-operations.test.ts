import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Git } from '../src/execution/git.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';

const providers: NodeTracerProvider[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  trace.disable();
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

function installOperations() {
  const exporter = new InMemorySpanExporter();
  const registry = new OperationRegistry();
  const provider = new NodeTracerProvider({ spanProcessors: [registry, new SimpleSpanProcessor(exporter)] });
  provider.register();
  providers.push(provider);
  return exporter;
}

describe('Git operation instrumentation (issue #287)', () => {
  it('records branch-cut, worktree, merge, rebase, and fast-forward as children of the active operation', async () => {
    const exporter = installOperations();
    const repo = makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-wt-'));
    tmpDirs.push(worktreeRoot);
    const featurePath = join(worktreeRoot, 'feature');
    const parent = startOperation({ type: 'attempt', attributes: {} });

    await parent.run(async () => {
      await Git.createBranch(repo, 'preview', 'main');
      await Git.addWorktree(repo, featurePath, 'feature', 'main');
      writeFileSync(join(featurePath, 'feature.txt'), 'feature\n');
      git(featurePath, 'add', '-A');
      git(featurePath, 'commit', '-m', 'feature');
      writeFileSync(join(repo, 'other.txt'), 'other\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'main moves');
      await Git.rebaseOnto(featurePath, await Git.revParse(repo, 'main'));
      await Git.ffOnly(repo, await Git.revParse(repo, 'feature'));
    });
    parent.end();

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'harmonic.attempt');
    if (!parentSpan) throw new Error('Expected parent operation span');
    for (const name of ['harmonic.git.branch-cut', 'harmonic.git.rebase', 'harmonic.git.ff-only']) {
      expect(spans.find((span) => span.name === name)?.parentSpanContext?.spanId).toBe(parentSpan.spanContext().spanId);
      expect(spans.find((span) => span.name === name)?.attributes['git.result']).toBe('ok');
    }
    expect(spans.find((span) => span.name === 'harmonic.git.branch-cut')?.attributes).toMatchObject({
      'git.branch': 'preview',
      'git.ref': 'main',
    });
  });

  it('marks a git failure as ERROR with its reason', async () => {
    const exporter = installOperations();
    const repo = makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-conflict-'));
    tmpDirs.push(worktreeRoot);
    const featurePath = join(worktreeRoot, 'feature');
    await Git.addWorktree(repo, featurePath, 'feature', 'main');
    writeFileSync(join(featurePath, 'base.txt'), 'feature version\n');
    git(featurePath, 'add', '-A');
    git(featurePath, 'commit', '-m', 'feature conflict');
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main conflict');
    const parent = startOperation({ type: 'merge', attributes: {} });

    const result = await parent.run(() => Git.rebaseOnto(featurePath, git(repo, 'rev-parse', 'main')));
    parent.end();

    expect(result.ok).toBe(false);
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'harmonic.git.rebase');
    expect(span?.status.code).toBe(2);
    expect(span?.status.message).toContain('git rebase');
    expect(span?.attributes).toMatchObject({
      'git.branch': 'HEAD',
      'git.result': 'error',
    });
  });

  it('does not create a standalone operation without an active Operation parent', async () => {
    const exporter = installOperations();
    const repo = makeRepo();

    await Git.ffOnly(repo, git(repo, 'rev-parse', 'main'));

    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe('worktreeDiff — live diff of a running Run against its fork point', () => {
  it('includes committed AND uncommitted tracked changes', async () => {
    const repo = makeRepo();
    const forkPoint = git(repo, 'rev-parse', 'HEAD');
    const wt = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-livewt-'));
    tmpDirs.push(wt);
    await Git.addWorktree(repo, wt, 'work', 'main');
    // One change committed on the branch, one left uncommitted in the worktree.
    writeFileSync(join(wt, 'committed.txt'), 'committed\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'committed work');
    writeFileSync(join(wt, 'base.txt'), 'edited but not committed\n');

    const base = await Git.mergeBase(repo, 'main', 'work');
    expect(base).toBe(forkPoint);

    const stat = await Git.worktreeDiffStat(wt, base);
    const unified = await Git.worktreeDiffUnified(wt, base);
    // The whole live state shows — both the committed file and the uncommitted edit.
    expect(stat).toContain('committed.txt');
    expect(stat).toContain('base.txt');
    expect(unified).toContain('edited but not committed');
  });

  it('surfaces in-progress work the committed base...branch range misses (the task-340 bug)', async () => {
    const repo = makeRepo();
    const wt = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-livewt2-'));
    tmpDirs.push(wt);
    await Git.addWorktree(repo, wt, 'work2', 'main');
    // Nothing committed on the branch — only an uncommitted edit, as for a running
    // attempt whose agent has not committed yet.
    writeFileSync(join(wt, 'base.txt'), 'uncommitted only\n');

    // The committed three-dot range (the old endpoint computation) sees nothing…
    expect(await Git.diffStat(repo, 'main', 'work2')).toBe('');
    // …but the live worktree diff surfaces the in-progress edit.
    const base = await Git.mergeBase(repo, 'main', 'work2');
    expect(await Git.worktreeDiffStat(wt, base)).toContain('base.txt');
  });
});

describe('Git.diffMergeCommit — the frozen whole-Epic diff from a merge commit (ADR-0018)', () => {
  it('diffs the merge commit\'s first parent against its second, surviving the feature branch\'s own deletion', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-b', 'feature', 'main');
    writeFileSync(join(repo, 'feature.txt'), 'from the feature branch\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'feature work');
    git(repo, 'checkout', 'main');
    git(repo, 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    const mergeOid = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', '-D', 'feature');

    const diff = await Git.diffMergeCommit(repo, mergeOid);
    expect(diff).toContain('feature.txt');
    expect(diff).toContain('+from the feature branch');
  });
});

describe('isValidWorktree / discardOrphanWorktree — orphaned per-task worktree heal (Task 340)', () => {
  it('heals a deregistered-but-present worktree so a later rebase succeeds', async () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-orphan-'));
    tmpDirs.push(root);
    const wt = join(root, 'task-1');
    await Git.addWorktree(repo, wt, 'harmonic/task-1', 'main');
    // A freshly-created worktree is live and registered.
    expect(await Git.isValidWorktree(repo, wt)).toBe(true);

    // Simulate the orphan: the directory survives on disk but its git
    // registration is gone (gitlink + backing admin dir removed), exactly the
    // state that made the live rebase run inside a non-repository.
    rmSync(join(wt, '.git'), { recursive: true, force: true });
    rmSync(join(repo, '.git', 'worktrees', 'task-1'), { recursive: true, force: true });
    expect(await Git.isValidWorktree(repo, wt)).toBe(false);
    // A rebase inside the orphan fails the way production did.
    const baseOid = git(repo, 'rev-parse', 'main');
    const brokenRebase = await Git.rebaseOnto(wt, baseOid);
    expect(brokenRebase.ok).toBe(false);

    // Heal: clear the stray directory, then re-create the worktree on the
    // surviving branch — the reuse path in prepareWorkspace.
    await Git.discardOrphanWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    await Git.addWorktreeCheckout(repo, wt, 'harmonic/task-1');
    expect(await Git.isValidWorktree(repo, wt)).toBe(true);

    // Move the base and rebase in the healed worktree — it now succeeds instead
    // of failing with "not a git repository".
    writeFileSync(join(repo, 'moved.txt'), 'moved\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'advance base');
    const movedOid = git(repo, 'rev-parse', 'main');
    const healedRebase = await Git.rebaseOnto(wt, movedOid);
    expect(healedRebase.ok).toBe(true);
  });

  it('removeWorktree leaves no orphaned directory behind', async () => {
    const repo = makeRepo();
    const root = mkdtempSync(join(tmpdir(), 'harmonic-git-operations-rm-'));
    tmpDirs.push(root);
    const wt = join(root, 'task-2');
    await Git.addWorktree(repo, wt, 'harmonic/task-2', 'main');
    expect(existsSync(wt)).toBe(true);
    await Git.removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
  });
});
