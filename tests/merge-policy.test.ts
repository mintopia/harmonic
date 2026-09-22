import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Git } from '../src/execution/git.js';
import { runMergePolicy, type MergePolicyDeps, type MergeStepEvent } from '../src/execution/merge-policy.js';
import { OperationRegistry, startOperation } from '../src/telemetry/operations.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harmonic-merge-policy-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

async function makeTaskBranch(repoDir: string, branchName: string, mutate: (worktreeDir: string) => void): Promise<void> {
  const wtRoot = mkdtempSync(join(tmpdir(), 'harmonic-merge-policy-wt-'));
  tmpDirs.push(wtRoot);
  const wt = join(wtRoot, branchName);
  await Git.addWorktree(repoDir, wt, branchName, 'main');
  mutate(wt);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-m', `${branchName} work`);
}

function neverCalled(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} must not be called`);
  });
}

describe('runMergePolicy (ADR-0001, "One merge policy, everywhere")', () => {
  it('merges a non-conflicting task branch with a real merge commit and does not escalate', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-clean', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-clean', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
    expect(Number(git(repo, 'rev-list', '--count', '--merges', 'HEAD'))).toBeGreaterThanOrEqual(1);
  });

  it('merges in a disposable worktree without changing the parked checkout', async () => {
    const repo = makeRepo();
    const mainTip = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-b', 'parked');
    writeFileSync(join(repo, 'parked.txt'), 'parked work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'parked commit');
    const parkedHead = git(repo, 'rev-parse', 'HEAD');
    const parkedStatus = git(repo, 'status', '--porcelain');
    await makeTaskBranch(repo, 'task-elsewhere', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    let postCheckDir = '';

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async (mergeOid, baseDir) => {
        postCheckDir = baseDir;
        expect(git(baseDir, 'rev-parse', 'HEAD')).toBe(mergeOid);
        expect(git(repo, 'rev-parse', 'main')).toBe(mainTip);
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-elsewhere', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('parked');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(parkedHead);
    expect(git(repo, 'status', '--porcelain')).toBe(parkedStatus);
    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'rev-parse', 'main^2')).toBeTruthy();
    expect(() => git(repo, 'show', 'main:feature.txt')).not.toThrow();
    expect(() => git(repo, 'show', 'parked:parked.txt')).not.toThrow();
    expect(postCheckDir).not.toBe(repo);
    expect(existsSync(postCheckDir)).toBe(false);
  });

  it('runs a post-merge check that adds a worktree on the same repo without deadlocking', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-postmerge', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async (mergeOid: string, baseDir: string) => {
        const wt = mkdtempSync(join(tmpdir(), 'harmonic-postmerge-wt-'));
        tmpDirs.push(wt);
        const checkout = join(wt, 'check');
        await Git.addDetachedWorktree(baseDir, checkout, mergeOid);
        await Git.removeWorktree(baseDir, checkout);
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-postmerge', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.runPostMergeCheck).toHaveBeenCalledOnce();
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('resolves a same-line conflict via one agentic turn and still merges cleanly', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-resolvable', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');

    const resolveConflictTurn = vi.fn(async (ctx) => {
      expect(ctx.unmergedPaths).toEqual(['base.txt']);
      expect(ctx.turn).toBe(1);
      writeFileSync(join(ctx.baseDir, 'base.txt'), 'resolved version\n');
      git(ctx.baseDir, 'add', 'base.txt');
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-resolvable', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(resolveConflictTurn).toHaveBeenCalledTimes(1);
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
  });

  it('escalates a conflict that outlasts the bounded resolve turns, with no merge left in progress', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-unresolvable', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');
    const originalHead = git(repo, 'rev-parse', 'HEAD');

    const resolveConflictTurn = vi.fn(async () => {
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-unresolvable', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe('conflict');
    expect(outcome.message).not.toContain('<<<<<<<');
    expect(resolveConflictTurn).toHaveBeenCalledTimes(2);
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(outcome.message);

    await expect(Git.revParse(repo, 'MERGE_HEAD')).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originalHead);
  });

  it('leaves the persistent checkout untouched when a merge conflicts', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-conflict', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');
    git(repo, 'checkout', '-b', 'parked');
    writeFileSync(join(repo, 'parked.txt'), 'parked work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'parked commit');
    const parkedHead = git(repo, 'rev-parse', 'HEAD');
    const parkedStatus = git(repo, 'status', '--porcelain');
    const mainHead = git(repo, 'rev-parse', 'main');

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-conflict', conflictResolveTurns: 0, postMergeCheck: false },
      {
        resolveConflictTurn: neverCalled('resolveConflictTurn'),
        runPostMergeCheck: neverCalled('runPostMergeCheck'),
        escalate: vi.fn(async () => {}),
      },
    );

    expect(outcome).toMatchObject({ kind: 'escalated', reason: 'conflict' });
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('parked');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(parkedHead);
    expect(git(repo, 'status', '--porcelain')).toBe(parkedStatus);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainHead);
    await expect(Git.revParse(repo, 'MERGE_HEAD')).rejects.toThrow();
  });

  it('discards the isolated merge and escalates with the failing output when the post-merge check goes red', async () => {
    const repo = makeRepo();
    const baseTip = git(repo, 'rev-parse', 'main');
    await makeTaskBranch(repo, 'task-red', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: false, output: 'BOOM tests failed' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-red', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe('post-merge-red');
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(expect.stringContaining('BOOM tests failed'));
    expect(git(repo, 'rev-parse', 'main')).toBe(baseTip);
    expect(() => git(repo, 'show', 'main:feature.txt')).toThrow();
  });

  it('skips the post-merge check when postMergeCheck is false', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-no-check', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-no-check', conflictResolveTurns: 2, postMergeCheck: false },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.runPostMergeCheck).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
  });

  it('resolves a multi-file conflict across two turns, re-reading the remaining conflicts each turn', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'shared a\n');
    writeFileSync(join(repo, 'c.txt'), 'shared c\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add shared files');

    await makeTaskBranch(repo, 'task-multi-conflict', (wt) => {
      writeFileSync(join(wt, 'a.txt'), 'task a\n');
      writeFileSync(join(wt, 'c.txt'), 'task c\n');
    });
    writeFileSync(join(repo, 'a.txt'), 'main a\n');
    writeFileSync(join(repo, 'c.txt'), 'main c\n');
    git(repo, 'commit', '-am', 'main edits a.txt and c.txt');

    const resolveConflictTurn = vi.fn(async (ctx) => {
      if (ctx.turn === 1) {
        writeFileSync(join(ctx.baseDir, 'a.txt'), 'resolved a\n');
        git(ctx.baseDir, 'add', 'a.txt');
      } else {
        expect(ctx.unmergedPaths).toEqual(['c.txt']);
        writeFileSync(join(ctx.baseDir, 'c.txt'), 'resolved c\n');
        git(ctx.baseDir, 'add', 'c.txt');
      }
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-multi-conflict', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(resolveConflictTurn).toHaveBeenCalledTimes(2);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(git(repo, 'rev-parse', 'HEAD^2')).toBeTruthy();
  });

  it('merges in an isolated worktree without ever leaving a merge in progress in the persistent checkout', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-dirty-base', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    // Dirty, uncommitted local change to the same file the task branch touched.
    writeFileSync(join(repo, 'base.txt'), 'dirty uncommitted\n');

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-dirty-base', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.escalate).not.toHaveBeenCalled();
    await expect(Git.revParse(repo, 'MERGE_HEAD')).rejects.toThrow();
  });

  it('accommodates a base advance before the CAS by rebuilding the merge on the new tip (issue #121)', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-race', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });
    git(repo, 'checkout', '-b', 'parked');
    writeFileSync(join(repo, 'racer.txt'), 'racer\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'racing update');
    const racerTip = git(repo, 'rev-parse', 'HEAD');
    let raced = false;
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => {
        // The base races ahead once, under the first build; the policy must
        // rebuild onto the new tip and merge there rather than escalating.
        if (!raced) {
          raced = true;
          git(repo, 'update-ref', 'refs/heads/main', racerTip);
        }
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-race', conflictResolveTurns: 0, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(git(repo, 'ls-tree', '--name-only', 'main', 'racer.txt')).toBe('racer.txt');
    expect(git(repo, 'ls-tree', '--name-only', 'main', 'feature.txt')).toBe('feature.txt');
  });

  it('escalates target-advanced when the base keeps advancing past the retry bound', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-race', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => {
        // The base advances to a brand-new commit on every build, so the CAS can
        // never win — the policy gives up after the bound and reports target-advanced.
        git(repo, 'commit', '--allow-empty', '-m', `race ${Date.now()}-${Math.random()}`);
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-race', conflictResolveTurns: 0, postMergeCheck: true },
      deps,
    );

    expect(outcome).toMatchObject({ kind: 'escalated', reason: 'target-advanced' });
  });

  it('does not hold the base-checkout lock while a conflict resolve turn runs', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-1', (wt) => {
      writeFileSync(join(wt, 'a.txt'), 'a\n');
    });
    let entered = false;
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => {
        entered = true;
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };
    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-1', conflictResolveTurns: 0, postMergeCheck: true },
      deps,
    );
    expect(outcome.kind).toBe('merged');
    expect(entered).toBe(true);
  });

  it('drops the metadata repo lock around each agentic turn so sibling worktree ops proceed (issue #455)', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-during-turn', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');
    const baseHead = git(repo, 'rev-parse', 'HEAD');

    let turnStarted!: () => void;
    const turnInProgress = new Promise<void>((r) => {
      turnStarted = r;
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => {
      releaseTurn = r;
    });

    const resolveConflictTurn = vi.fn(async (ctx) => {
      turnStarted();
      await turnGate;
      writeFileSync(join(ctx.baseDir, 'base.txt'), 'resolved\n');
      git(ctx.baseDir, 'add', 'base.txt');
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn,
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const mergePromise = runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-during-turn', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    await turnInProgress;
    const wtRoot = mkdtempSync(join(tmpdir(), 'harmonic-sibling-wt-'));
    tmpDirs.push(wtRoot);
    const checkout = join(wtRoot, 'check');
    await Git.addDetachedWorktree(repo, checkout, baseHead);
    await Git.removeWorktree(repo, checkout);

    releaseTurn();
    const outcome = await mergePromise;
    expect(outcome.kind).toBe('merged');
    expect(resolveConflictTurn).toHaveBeenCalledTimes(1);
  });

});

describe('runMergePolicy telemetry (ADR-0010, #387)', () => {
  const providers: NodeTracerProvider[] = [];
  afterEach(async () => {
    trace.disable();
    context.disable();
    propagation.disable();
    await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  });

  it('emits a nested merge span tree under the active operation on a clean merge', async () => {
    const exporter = new InMemorySpanExporter();
    const registry = new OperationRegistry();
    const provider = new NodeTracerProvider({ spanProcessors: [registry, new SimpleSpanProcessor(exporter)] });
    provider.register();
    providers.push(provider);

    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-traced', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const parent = startOperation({ type: 'attempt', attributes: {} });
    const outcome = await parent.run(() =>
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-traced', conflictResolveTurns: 2, postMergeCheck: true },
        deps,
      ),
    );
    parent.end();

    expect(outcome.kind).toBe('merged');

    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.find((span) => span.name === name);
    const attempt = byName('harmonic.attempt');
    const merge = byName('harmonic.merge');
    const wait = byName('harmonic.merge.lock-wait');
    const hold = byName('harmonic.merge.lock-hold');
    const postCheck = byName('harmonic.merge.post-check');
    if (!attempt || !merge || !wait || !hold || !postCheck) {
      throw new Error(`missing span(s): ${JSON.stringify(spans.map((s) => s.name))}`);
    }
    expect(merge.attributes['merge.mechanism']).toBe('policy');
    expect(merge.attributes['merge.outcome']).toBe('merged');
    expect(merge.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(wait.parentSpanContext?.spanId).toBe(merge.spanContext().spanId);
    expect(hold.parentSpanContext?.spanId).toBe(merge.spanContext().spanId);
    expect(postCheck.parentSpanContext?.spanId).toBe(merge.spanContext().spanId);
  });
});

describe('runMergePolicy onStep (merge-visibility events)', () => {
  const collect = (): { steps: MergeStepEvent[]; onStep: (e: MergeStepEvent) => void } => {
    const steps: MergeStepEvent[] = [];
    return { steps, onStep: (e) => steps.push(e) };
  };

  it('emits started → post-check-skipped → merged for a clean merge with no post-merge check', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-clean', (wt) => writeFileSync(join(wt, 'feature.txt'), 'feature\n'));
    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-clean', conflictResolveTurns: 2, postMergeCheck: false },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'post-check-skipped', 'checkout-synced', 'merged']);
    const merged = sink.steps.find((s) => s.step === 'merged');
    expect(merged && 'mergeOid' in merged && merged.mergeOid).toBeTruthy();
  });

  it('emits started → post-check-passed → merged when the post-merge check passes', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-checked', (wt) => writeFileSync(join(wt, 'feature.txt'), 'feature\n'));
    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-checked', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'post-check-passed', 'checkout-synced', 'merged']);
  });

  it('emits started → escalated when the post-merge check fails', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-red', (wt) => writeFileSync(join(wt, 'feature.txt'), 'feature\n'));
    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: false, output: 'suite failed' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-red', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('escalated');
    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'escalated']);
    const escalated = sink.steps.find((s) => s.step === 'escalated');
    expect(escalated && 'reason' in escalated && escalated.reason).toBe('post-merge-red');
  });

  it('emits started → conflict(paths) → escalated when a conflict cannot be resolved', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-conflict', (wt) => writeFileSync(join(wt, 'base.txt'), 'task change\n'));
    writeFileSync(join(repo, 'base.txt'), 'main change\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'diverging main change');
    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-conflict', conflictResolveTurns: 0, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('escalated');
    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'conflict', 'escalated']);
    const conflict = sink.steps.find((s) => s.step === 'conflict');
    expect(conflict && 'paths' in conflict && conflict.paths).toContain('base.txt');
  });
});

describe('base checkout sync (accommodating a dirty base checkout)', () => {
  const collect = (): { steps: MergeStepEvent[]; onStep: (e: MergeStepEvent) => void } => {
    const steps: MergeStepEvent[] = [];
    return { steps, onStep: (e) => steps.push(e) };
  };

  function findSyncStep(steps: MergeStepEvent[]): Extract<MergeStepEvent, { step: 'checkout-synced' }> {
    const step = steps.find((s) => s.step === 'checkout-synced');
    if (!step || step.step !== 'checkout-synced') throw new Error('no checkout-synced step emitted');
    return step;
  }

  it('fast-forwards a clean checkout to the merge tip', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-ff', (wt) => writeFileSync(join(wt, 'feature.txt'), 'feature\n'));
    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-ff', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    const sync = findSyncStep(sink.steps);
    expect(sync.mergedPaths).toEqual([]);
    expect(sync.keptPaths).toEqual([]);
  });

  it('preserves unrelated staged, unstaged and untracked operator changes across the merge', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-unrelated', (wt) => writeFileSync(join(wt, 'feature.txt'), 'feature\n'));
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', 'staged.txt');
    writeFileSync(join(repo, 'base.txt'), 'unstaged edit\n');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-unrelated', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('unstaged edit\n');
    const lines = git(repo, 'status', '--porcelain').split('\n').sort();
    expect(lines).toEqual(['?? untracked.txt', 'A  staged.txt', 'M base.txt'].sort());
  });

  it('combines non-overlapping edits to the same file via a 3-way merge', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'multi.txt'), 'one\ntwo\nthree\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add multi.txt');
    await makeTaskBranch(repo, 'task-nonoverlap', (wt) => {
      writeFileSync(join(wt, 'multi.txt'), 'TASK-one\ntwo\nthree\n');
    });
    writeFileSync(join(repo, 'multi.txt'), 'one\ntwo\nOPERATOR-three\n');

    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-nonoverlap', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(readFileSync(join(repo, 'multi.txt'), 'utf8')).toBe('TASK-one\ntwo\nOPERATOR-three\n');
    const sync = findSyncStep(sink.steps);
    expect(sync.mergedPaths).toEqual(['multi.txt']);
    expect(sync.keptPaths).toEqual([]);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M multi.txt');
  });

  it("keeps the operator's bytes when the same file has conflicting edits", async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-conflict-hunk', (wt) => writeFileSync(join(wt, 'base.txt'), 'task version\n'));
    writeFileSync(join(repo, 'base.txt'), 'dirty uncommitted\n');

    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-conflict-hunk', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(deps.escalate).not.toHaveBeenCalled();
    const content = readFileSync(join(repo, 'base.txt'), 'utf8');
    expect(content).toBe('dirty uncommitted\n');
    expect(content).not.toContain('<<<<<<<');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    const sync = findSyncStep(sink.steps);
    expect(sync.keptPaths).toEqual(['base.txt']);
    expect(sync.mergedPaths).toEqual([]);
  });

  it("keeps the operator's edit when the merge deletes the file", async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-deletes', (wt) => {
      execFileSync('git', ['-C', wt, 'rm', '-q', 'base.txt']);
    });
    writeFileSync(join(repo, 'base.txt'), 'operator edit\n');

    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-deletes', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('operator edit\n');
    const sync = findSyncStep(sink.steps);
    expect(sync.keptPaths).toEqual(['base.txt']);
  });

  it("keeps the operator's untracked or ignored file when the merge adds the same path", async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-adds', (wt) => {
      writeFileSync(join(wt, 'untracked-collide.txt'), 'task new\n');
      writeFileSync(join(wt, 'ignored-collide.txt'), 'task new\n');
    });
    writeFileSync(join(repo, '.gitignore'), 'ignored-collide.txt\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore ignored-collide.txt');
    writeFileSync(join(repo, 'untracked-collide.txt'), 'operator new\n');
    writeFileSync(join(repo, 'ignored-collide.txt'), 'operator ignored\n');

    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-adds', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(readFileSync(join(repo, 'untracked-collide.txt'), 'utf8')).toBe('operator new\n');
    expect(readFileSync(join(repo, 'ignored-collide.txt'), 'utf8')).toBe('operator ignored\n');
    const sync = findSyncStep(sink.steps);
    expect([...sync.keptPaths].sort()).toEqual(['ignored-collide.txt', 'untracked-collide.txt']);
  });

  it('leaves an unrelated checked-out branch untouched and emits no sync step', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-other-branch', (wt) => writeFileSync(join(wt, 'feature.txt'), 'feature\n'));
    git(repo, 'checkout', '-b', 'parked');
    writeFileSync(join(repo, 'parked-only.txt'), 'parked\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'parked work');

    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-other-branch', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('parked');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    expect(existsSync(join(repo, 'parked-only.txt'))).toBe(true);
    expect(sink.steps.some((s) => s.step === 'checkout-synced')).toBe(false);
    expect(git(repo, 'ls-tree', '--name-only', 'main', 'feature.txt')).toBe('feature.txt');
  });

  it('keeps a single failing overlap path without aborting the rest of the sync', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'ok.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'boom.txt'), 'one\ntwo\nthree\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add ok.txt and boom.txt');
    await makeTaskBranch(repo, 'task-partial-failure', (wt) => {
      writeFileSync(join(wt, 'ok.txt'), 'TASK-one\ntwo\nthree\n');
      writeFileSync(join(wt, 'boom.txt'), 'TASK-one\ntwo\nthree\n');
    });
    writeFileSync(join(repo, 'ok.txt'), 'one\ntwo\nOPERATOR-three\n');
    writeFileSync(join(repo, 'boom.txt'), 'one\ntwo\nOPERATOR-three\n');

    const original = Git.mergeFileResult.bind(Git);
    const spy = vi.spyOn(Git, 'mergeFileResult').mockImplementation(async (oursPath, basePath, theirsPath) => {
      if (oursPath.endsWith('boom.txt')) throw new Error('injected failure');
      return original(oursPath, basePath, theirsPath);
    });

    const sink = collect();
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
      onStep: sink.onStep,
    };

    try {
      const outcome = await runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-partial-failure', conflictResolveTurns: 2, postMergeCheck: true },
        deps,
      );

      expect(outcome.kind).toBe('merged');
      expect(readFileSync(join(repo, 'ok.txt'), 'utf8')).toBe('TASK-one\ntwo\nOPERATOR-three\n');
      expect(readFileSync(join(repo, 'boom.txt'), 'utf8')).toBe('one\ntwo\nOPERATOR-three\n');
      const sync = findSyncStep(sink.steps);
      expect(sync.mergedPaths).toEqual(['ok.txt']);
      expect(sync.keptPaths).toEqual(['boom.txt']);
    } finally {
      spy.mockRestore();
    }
  });
});
