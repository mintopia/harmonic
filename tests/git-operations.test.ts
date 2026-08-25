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
      await Git.merge(repo, 'main', 'feature');
      await Git.ffOnly(repo, await Git.revParse(repo, 'main'));
    });
    parent.end();

    const spans = exporter.getFinishedSpans();
    const parentSpan = spans.find((span) => span.name === 'harmonic.run');
    if (!parentSpan) throw new Error('Expected parent operation span');
    for (const name of ['harmonic.git.branch-cut', 'harmonic.git.rebase', 'harmonic.git.merge', 'harmonic.git.ff-only']) {
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
    const parent = startOperation({ type: 'land', attributes: {} });

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

describe('Git.mergeCleanliness (read-only merge-tree fact for the critic, ADR-0021)', () => {
  /** A snapshot of everything a mutation would move: HEAD, every ref, and the
   * working-tree porcelain status. merge-tree writes only objects, so all three
   * must be byte-identical before and after. */
  function snapshot(dir: string): string {
    return [
      git(dir, 'rev-parse', 'HEAD'),
      git(dir, 'for-each-ref', '--format=%(objectname) %(refname)'),
      git(dir, 'status', '--porcelain'),
    ].join('\n');
  }

  it('reports a clean merge without mutating the working tree or refs', async () => {
    const repo = makeRepo(); // main @ base.txt
    // A candidate ahead of main on its own ref (main stays put), adding a file —
    // it merges cleanly into main.
    git(repo, 'checkout', '-b', 'cand');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'candidate');
    const candidate = git(repo, 'rev-parse', 'cand');
    git(repo, 'checkout', 'main');

    const before = snapshot(repo);
    const result = await Git.mergeCleanliness(repo, 'main', candidate);
    expect(result).toEqual({ clean: true });
    expect(snapshot(repo)).toBe(before);
  });

  it('reports a conflicting merge and names the conflicting path, still read-only', async () => {
    const repo = makeRepo();
    const mergeBase = git(repo, 'rev-parse', 'HEAD'); // initial commit (base.txt = base)
    // main advances one way…
    writeFileSync(join(repo, 'base.txt'), 'MAIN\n');
    git(repo, 'commit', '-am', 'main edits base.txt');
    // …the candidate forks from the merge-base and edits the same line another way.
    git(repo, 'checkout', '-b', 'cand', mergeBase);
    writeFileSync(join(repo, 'base.txt'), 'CANDIDATE\n');
    git(repo, 'commit', '-am', 'candidate edits base.txt');
    const candidate = git(repo, 'rev-parse', 'cand');
    git(repo, 'checkout', 'main');

    const before = snapshot(repo);
    const result = await Git.mergeCleanliness(repo, 'main', candidate);
    expect(result?.clean).toBe(false);
    expect(result?.conflicts ?? '').toContain('base.txt');
    expect(snapshot(repo)).toBe(before);
  });

  it('returns null (unknown) when the base branch does not exist', async () => {
    const repo = makeRepo();
    const candidate = git(repo, 'rev-parse', 'HEAD');
    expect(await Git.mergeCleanliness(repo, 'no-such-branch', candidate)).toBeNull();
  });
});
