import { describe, expect, it } from 'vitest';
import { EpicRefreshCoordinator } from '../src/execution/epic-refresh-coordinator.js';
import { MergeTrainCoordinator } from '../src/execution/merge-train-coordinator.js';
import type { LandBranchOutcome } from '../src/execution/branch-landing.js';

const train = () => new MergeTrainCoordinator({
  dispatchHeal: async () => {},
  escalate: async () => {},
});

const conflict = (detail = 'both changed package.json'): LandBranchOutcome => ({
  ok: false,
  reason: 'conflict',
  detail,
});

describe('EpicRefreshCoordinator', () => {
  it('merges develop into an integration branch through the merge train', async () => {
    const calls: string[] = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      land: async ({ baseBranch, branch }) => {
        calls.push(`${baseBranch}<-${branch}`);
        return { ok: true, mode: 'cas', oid: 'merge-oid', baseBranch, branch };
      },
      dispatchResolve: async () => ({ status: 'dispatched' }),
      escalate: () => {},
    });

    await expect(coordinator.refresh({ ref: 42, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'refreshed', oid: 'merge-oid',
    });
    expect(calls).toEqual(['epic/42<-develop']);
  });

  it('dispatches exactly one resolution turn, then escalates the Epic with the recorded conflict', async () => {
    const outcomes = [conflict('first conflict'), conflict('second conflict')];
    const resolutions: string[] = [];
    const escalations: Array<{ ref: number; reason: string }> = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      land: async () => outcomes.shift()!,
      dispatchResolve: async (_target, detail) => {
        resolutions.push(detail);
        return { status: 'dispatched' };
      },
      escalate: (ref, reason) => { escalations.push({ ref, reason }); },
    });

    await expect(coordinator.refresh({ ref: 7, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'resolving', detail: 'first conflict',
    });
    await expect(coordinator.refresh({ ref: 7, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toMatchObject({
      status: 'escalated',
    });
    expect(resolutions).toEqual(['first conflict']);
    expect(escalations).toEqual([{ ref: 7, reason: expect.stringContaining('second conflict') }]);
  });

  it('serializes refreshes for the same integration branch', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const starts: number[] = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      land: async () => {
        starts.push(starts.length + 1);
        if (starts.length === 1) await first;
        return { ok: true, mode: 'cas', oid: `oid-${starts.length}`, baseBranch: 'epic/9', branch: 'develop' };
      },
      dispatchResolve: async () => ({ status: 'dispatched' }),
      escalate: () => {},
    });

    const one = coordinator.refresh({ ref: 9, repoDir: '/repo', defaultBranch: 'develop' });
    const two = coordinator.refresh({ ref: 9, repoDir: '/repo', defaultBranch: 'develop' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toEqual([1]);
    release();
    await Promise.all([one, two]);
    expect(starts).toEqual([1, 2]);
  });

  it('defers a checked-out integration branch instead of falsely escalating it', async () => {
    const escalations: string[] = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      land: async () => ({ ok: false, reason: 'fallback-pr-manual', detail: 'branch is checked out' }),
      dispatchResolve: async () => ({ status: 'dispatched' }),
      escalate: (_ref, reason) => { escalations.push(reason); },
    });

    await expect(coordinator.refresh({ ref: 12, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'deferred', reason: 'branch is checked out',
    });
    expect(escalations).toEqual([]);
  });

  it('does not record a resolution attempt until dispatch succeeds', async () => {
    const dispatches: string[] = [];
    const escalations: string[] = [];
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      land: async () => conflict('refresh conflict'),
      dispatchResolve: async (_target, detail) => {
        dispatches.push(detail);
        if (dispatches.length === 1) throw new Error('no corrective turn was dispatched');
        return { status: 'dispatched' };
      },
      escalate: (_ref, reason) => { escalations.push(reason); },
    });
    const target = { ref: 13, repoDir: '/repo', defaultBranch: 'develop' };

    await expect(coordinator.refresh(target)).rejects.toThrow('no corrective turn was dispatched');
    await expect(coordinator.refresh(target)).resolves.toEqual({
      status: 'resolving', detail: 'refresh conflict',
    });
    expect(dispatches).toEqual(['refresh conflict', 'refresh conflict']);
    expect(escalations).toEqual([]);
  });

  it('returns an escalation when no running member can host a refresh resolution', async () => {
    const coordinator = new EpicRefreshCoordinator({
      train: train(),
      land: async () => conflict('refresh conflict'),
      dispatchResolve: async () => ({
        status: 'escalated',
        reason: 'no active Epic member is available to resolve refresh conflict for epic/14',
      }),
      escalate: () => {},
    });

    await expect(coordinator.refresh({ ref: 14, repoDir: '/repo', defaultBranch: 'develop' })).resolves.toEqual({
      status: 'escalated',
      reason: 'no active Epic member is available to resolve refresh conflict for epic/14',
    });
  });
});
