import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('checks the base branch out to merge a different base, then restores the parked branch', async () => {
    const repo = makeRepo();
    const mainTip = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-b', 'parked');
    writeFileSync(join(repo, 'parked.txt'), 'parked work\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'parked commit');
    await makeTaskBranch(repo, 'task-elsewhere', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    const outcome = await runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-elsewhere', conflictResolveTurns: 2, postMergeCheck: true },
      deps,
    );

    expect(outcome.kind).toBe('merged');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('parked');
    expect(git(repo, 'rev-parse', 'main')).not.toBe(mainTip);
    expect(git(repo, 'rev-parse', 'main^2')).toBeTruthy();
    expect(() => git(repo, 'show', 'main:feature.txt')).not.toThrow();
    expect(() => git(repo, 'show', 'parked:parked.txt')).not.toThrow();
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

  it('reverts the merge and escalates with the failing output when the post-merge check goes red', async () => {
    const repo = makeRepo();
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
    expect(outcome.revertOid).toBeTruthy();
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(expect.stringContaining('BOOM tests failed'));

    expect(() => git(repo, 'show', 'HEAD:feature.txt')).toThrow();
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

  it('throws on a non-conflict merge fault without escalating', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-dirty-base', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    // Dirty, uncommitted local change to base.txt: `git merge --no-ff` refuses
    // before starting a merge ("local changes would be overwritten") — a
    // non-conflict fault, no MERGE_HEAD is ever created.
    writeFileSync(join(repo, 'base.txt'), 'dirty uncommitted\n');

    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: neverCalled('runPostMergeCheck'),
      escalate: vi.fn(async () => {}),
    };

    await expect(
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-dirty-base', conflictResolveTurns: 2, postMergeCheck: true },
        deps,
      ),
    ).rejects.toThrow();

    expect(deps.escalate).not.toHaveBeenCalled();
    await expect(Git.revParse(repo, 'MERGE_HEAD')).rejects.toThrow();
  });

  it('serialises two concurrent merges into the same base repo under one mutex', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-1', (wt) => {
      writeFileSync(join(wt, 'a.txt'), 'a\n');
    });
    await makeTaskBranch(repo, 'task-2', (wt) => {
      writeFileSync(join(wt, 'b.txt'), 'b\n');
    });

    let active = 0;
    let maxActive = 0;
    const runPostMergeCheck = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(active).toBeLessThanOrEqual(1);
      active--;
      return { pass: true, output: '' };
    });
    const deps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck,
      escalate: vi.fn(async () => {}),
    };

    const [outcome1, outcome2] = await Promise.all([
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-1', conflictResolveTurns: 0, postMergeCheck: true },
        deps,
      ),
      runMergePolicy(
        { baseDir: repo, baseBranch: 'main', taskBranch: 'task-2', conflictResolveTurns: 0, postMergeCheck: true },
        deps,
      ),
    ]);

    expect(outcome1.kind).toBe('merged');
    expect(outcome2.kind).toBe('merged');
    expect(maxActive).toBe(1);
    expect(runPostMergeCheck).toHaveBeenCalledTimes(2);
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

  it('holds the base-checkout lock across the turn so a sibling merge waits (issue #455)', async () => {
    const repo = makeRepo();
    await makeTaskBranch(repo, 'task-conflict', (wt) => {
      writeFileSync(join(wt, 'base.txt'), 'task version\n');
    });
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'commit', '-am', 'main edits base.txt');
    await makeTaskBranch(repo, 'task-clean-sibling', (wt) => {
      writeFileSync(join(wt, 'feature.txt'), 'feature\n');
    });

    let turnStarted!: () => void;
    const turnInProgress = new Promise<void>((r) => {
      turnStarted = r;
    });
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => {
      releaseTurn = r;
    });

    const conflictDeps: MergePolicyDeps = {
      resolveConflictTurn: vi.fn(async (ctx) => {
        turnStarted();
        await turnGate;
        writeFileSync(join(ctx.baseDir, 'base.txt'), 'resolved\n');
        git(ctx.baseDir, 'add', 'base.txt');
      }),
      runPostMergeCheck: vi.fn(async () => ({ pass: true, output: '' })),
      escalate: vi.fn(async () => {}),
    };

    let siblingMergeEntered = false;
    const siblingDeps: MergePolicyDeps = {
      resolveConflictTurn: neverCalled('resolveConflictTurn'),
      runPostMergeCheck: vi.fn(async () => {
        siblingMergeEntered = true;
        return { pass: true, output: '' };
      }),
      escalate: vi.fn(async () => {}),
    };

    const conflictMerge = runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-conflict', conflictResolveTurns: 2, postMergeCheck: true },
      conflictDeps,
    );

    await turnInProgress;
    const siblingMerge = runMergePolicy(
      { baseDir: repo, baseBranch: 'main', taskBranch: 'task-clean-sibling', conflictResolveTurns: 0, postMergeCheck: true },
      siblingDeps,
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(siblingMergeEntered).toBe(false);

    releaseTurn();
    const [conflictOutcome, siblingOutcome] = await Promise.all([conflictMerge, siblingMerge]);
    expect(conflictOutcome.kind).toBe('merged');
    expect(siblingOutcome.kind).toBe('merged');
    expect(siblingMergeEntered).toBe(true);
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
    expect(postCheck.parentSpanContext?.spanId).toBe(hold.spanContext().spanId);
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
    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'post-check-skipped', 'merged']);
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

    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'post-check-passed', 'merged']);
  });

  it('emits started → reverted → escalated when the post-merge check fails', async () => {
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
    expect(sink.steps.map((s) => s.step)).toEqual(['started', 'reverted', 'escalated']);
    const reverted = sink.steps.find((s) => s.step === 'reverted');
    expect(reverted && 'revertOid' in reverted && reverted.revertOid).toBeTruthy();
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
