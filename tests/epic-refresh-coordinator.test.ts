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
      dispatchResolve: async () => {},
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
      dispatchResolve: async (_target, detail) => { resolutions.push(detail); },
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
      dispatchResolve: async () => {},
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
});
