import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EpicCoordinator, type EpicGit, type EpicIntegrate } from '../src/execution/epic-coordinator.js';
import { RESOLVE_TURN_TIMEOUT_MS } from '../src/execution/merge-coordinator.js';
import { trackerRef } from '../src/tracker/adapter.js';

const git: Pick<EpicGit, 'branchExists' | 'revParse' | 'symbolicBranch' | 'isAncestor' | 'isContentContained'> = {
  branchExists: async () => true,
  revParse: async (_dir, rev) => `oid-${rev}`,
  symbolicBranch: async () => 'develop',
  isAncestor: async () => false,
  isContentContained: async () => false,
};

describe('Epic operation timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const submitWithTwoConflictTurns = async (operationTimeoutMs?: number) => {
    const escalate = vi.fn();
    const integrate: EpicIntegrate = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2 * RESOLVE_TURN_TIMEOUT_MS + 60_000));
      return { kind: 'merged', mergeOid: 'merged-oid' };
    };
    const coord = new EpicCoordinator({
      repoDir: '/repo',
      git: git as EpicGit,
      verify: async () => ({ outcome: 'proceed', reason: 'ok' }),
      integrate,
      retire: async () => {},
      escalate,
      ...(operationTimeoutMs !== undefined ? { operationTimeoutMs } : {}),
    });
    const submitted = coord.submit({ ref: trackerRef(42), members: ['completed'] });
    await vi.advanceTimersByTimeAsync(3 * RESOLVE_TURN_TIMEOUT_MS);
    return { out: await submitted, escalate };
  };

  it('lets an Epic merge needing two full conflict-resolution turns complete', async () => {
    const { out, escalate } = await submitWithTwoConflictTurns();
    expect(out).toEqual({ status: 'integrated', oid: 'merged-oid' });
    expect(escalate).not.toHaveBeenCalled();
  });

  it('escalates the same merge under the previous 20 minute bound', async () => {
    const { out, escalate } = await submitWithTwoConflictTurns(20 * 60_000);
    expect(out.status).toBe('escalated');
    expect(escalate).toHaveBeenCalledWith('42', expect.stringContaining('timed out'));
  });
});
