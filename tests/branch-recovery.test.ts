import { describe, it, expect } from 'vitest';
import {
  BRANCH_OUTCOMES,
  classifyBranchOutcome,
  type BranchContractObservation,
  type RefDelta,
} from '../src/domain/branch-recovery.js';

const A = 'a'.repeat(40); // recorded start commit
const B = 'b'.repeat(40); // an advanced/candidate tip
const C = 'c'.repeat(40); // an unrelated / unknown commit

const THIS_RUN = 42;

/** An owned candidate ref move by this Run: start → B. */
function ownedCandidate(overrides: Partial<RefDelta> = {}): RefDelta {
  return {
    ref: `refs/harmonic/direct/run-${THIS_RUN}`,
    from: A,
    to: B,
    attributedRunId: THIS_RUN,
    ...overrides,
  };
}

/**
 * A clean, on-branch, in-worktree observation with no ref deltas — the Run
 * honoured the contract. Individual tests override the fields under test.
 */
function cleanObs(overrides: Partial<BranchContractObservation> = {}): BranchContractObservation {
  return {
    runId: THIS_RUN,
    intendedBranch: 'develop',
    startCommit: A,
    expectedWorktreePath: '/work',
    headBranch: 'develop',
    headCommit: A,
    worktreePath: '/work',
    refDeltas: [],
    reachability: { intendedContainsStart: true, intendedContainsHead: true },
    ...overrides,
  };
}

describe('classifyBranchOutcome (issue #150, pure branch-contract classifier)', () => {
  it('pins the outcome set', () => {
    expect(BRANCH_OUTCOMES).toEqual(['clean', 'recoverable', 'ambiguous']);
  });

  it('is total and deterministic: same input yields the same verdict', () => {
    const obs = cleanObs({ refDeltas: [ownedCandidate()] });
    expect(classifyBranchOutcome(obs)).toEqual(classifyBranchOutcome(obs));
  });

  describe('clean', () => {
    it('classifies HEAD still on the intended branch in the expected worktree as clean', () => {
      expect(classifyBranchOutcome(cleanObs()).outcome).toBe('clean');
    });

    it('an owned candidate ref off to the side does not spoil clean', () => {
      // Worktree-mode: HEAD stayed on the branch; Harmonic built a candidate ref.
      const obs = cleanObs({ refDeltas: [ownedCandidate()] });
      expect(classifyBranchOutcome(obs).outcome).toBe('clean');
    });

    it('normalises a fully-qualified intended branch against a short HEAD branch', () => {
      const obs = cleanObs({ intendedBranch: 'refs/heads/develop', headBranch: 'develop' });
      expect(classifyBranchOutcome(obs).outcome).toBe('clean');
    });
  });

  describe('ambiguous → escalate', () => {
    it('an unattributed ref delta is ambiguous (owned-ref invariant)', () => {
      // Agent ran `git checkout -b stray && commit`: Harmonic never tagged it.
      const stray: RefDelta = {
        ref: 'refs/heads/stray',
        from: null,
        to: B,
        attributedRunId: null,
      };
      const v = classifyBranchOutcome(cleanObs({ refDeltas: [stray] }));
      expect(v.outcome).toBe('ambiguous');
      if (v.outcome !== 'ambiguous') return;
      expect(v.reason).toBe('unattributed-ref-delta');
      expect(v.deltas).toContain(stray);
    });

    it('a ref moved by a different Run is ambiguous with a distinct reason', () => {
      const foreign: RefDelta = {
        ref: 'refs/heads/develop',
        from: A,
        to: B,
        attributedRunId: THIS_RUN + 1,
      };
      const v = classifyBranchOutcome(
        cleanObs({ headCommit: B, refDeltas: [foreign] }),
      );
      expect(v.outcome).toBe('ambiguous');
      if (v.outcome !== 'ambiguous') return;
      expect(v.reason).toBe('foreign-ref-delta');
      expect(v.deltas).toContain(foreign);
    });

    it('a truly unattributed delta outranks a foreign one', () => {
      const nullDelta: RefDelta = { ref: 'refs/heads/stray', from: null, to: B, attributedRunId: null };
      const foreign: RefDelta = { ref: 'refs/heads/other', from: null, to: C, attributedRunId: THIS_RUN + 1 };
      const v = classifyBranchOutcome(cleanObs({ refDeltas: [foreign, nullDelta] }));
      expect(v.outcome).toBe('ambiguous');
      if (v.outcome !== 'ambiguous') return;
      expect(v.reason).toBe('unattributed-ref-delta');
    });

    it('a diverged intended branch (recorded start no longer reachable) is ambiguous', () => {
      // History rewrite: startCommit is not an ancestor of the intended tip.
      const v = classifyBranchOutcome(
        cleanObs({
          headCommit: C,
          reachability: { intendedContainsStart: false, intendedContainsHead: true },
        }),
      );
      expect(v.outcome).toBe('ambiguous');
      if (v.outcome !== 'ambiguous') return;
      expect(v.reason).toBe('intended-branch-diverged');
    });

    it('HEAD parked on an unknown, unattributed, unreachable commit is ambiguous', () => {
      // Detached onto C: not the start, not an owned ref tip, not on the branch.
      const v = classifyBranchOutcome(
        cleanObs({
          headBranch: null,
          headCommit: C,
          reachability: { intendedContainsStart: true, intendedContainsHead: false },
        }),
      );
      expect(v.outcome).toBe('ambiguous');
      if (v.outcome !== 'ambiguous') return;
      expect(v.reason).toBe('head-at-unknown-commit');
    });
  });

  describe('recoverable (deterministic)', () => {
    it('direct-mode HEAD detached onto its own owned candidate ref is recoverable', () => {
      // #152 isolation footprint: HEAD detached at the private candidate tip.
      const v = classifyBranchOutcome(
        cleanObs({
          headBranch: null,
          headCommit: B,
          refDeltas: [ownedCandidate()],
          reachability: { intendedContainsStart: true, intendedContainsHead: false },
        }),
      );
      expect(v.outcome).toBe('recoverable');
      if (v.outcome !== 'recoverable') return;
      expect(v.reason).toBe('head-detached-on-owned-ref');
    });

    it('HEAD on a different but attributed branch is recoverable (re-point)', () => {
      // Harmonic itself moved HEAD to an owned branch; every delta is attributed.
      const owned: RefDelta = {
        ref: 'refs/heads/harmonic-work',
        from: null,
        to: B,
        attributedRunId: THIS_RUN,
      };
      const v = classifyBranchOutcome(
        cleanObs({
          headBranch: 'harmonic-work',
          headCommit: B,
          refDeltas: [owned],
          reachability: { intendedContainsStart: true, intendedContainsHead: false },
        }),
      );
      expect(v.outcome).toBe('recoverable');
      if (v.outcome !== 'recoverable') return;
      expect(v.reason).toBe('head-off-intended-branch');
    });

    it('right branch but relocated worktree is recoverable', () => {
      const v = classifyBranchOutcome(cleanObs({ worktreePath: '/somewhere/else' }));
      expect(v.outcome).toBe('recoverable');
      if (v.outcome !== 'recoverable') return;
      expect(v.reason).toBe('worktree-relocated');
    });

    it('HEAD detached at the recorded start commit is recoverable, not ambiguous', () => {
      const v = classifyBranchOutcome(
        cleanObs({
          headBranch: null,
          headCommit: A,
          reachability: { intendedContainsStart: true, intendedContainsHead: true },
        }),
      );
      expect(v.outcome).toBe('recoverable');
      if (v.outcome !== 'recoverable') return;
      expect(v.reason).toBe('head-detached-on-owned-ref');
    });
  });

  describe('precedence', () => {
    it('an unattributed delta outranks a mere checkout deviation', () => {
      // Both a stray unattributed ref AND a relocated worktree: escalate wins.
      const stray: RefDelta = { ref: 'refs/heads/stray', from: null, to: B, attributedRunId: null };
      const v = classifyBranchOutcome(
        cleanObs({ worktreePath: '/elsewhere', refDeltas: [stray] }),
      );
      expect(v.outcome).toBe('ambiguous');
      if (v.outcome !== 'ambiguous') return;
      expect(v.reason).toBe('unattributed-ref-delta');
    });
  });
});
