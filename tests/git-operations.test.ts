import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const parent = startOperation({ type: 'run', attributes: {} });

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
    const parentSpan = spans.find((span) => span.name === 'harmonic.run');
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
