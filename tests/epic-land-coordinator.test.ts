import { describe, it, expect, vi } from 'vitest';
import { EpicLandCoordinator, type EpicLandGit } from '../src/execution/epic-land-coordinator.js';
import type { LandBranchArgs, LandBranchOutcome } from '../src/execution/branch-landing.js';
import type { VerificationDecision } from '../src/verification/combine.js';
import type { MemberLandState } from '../src/domain/epic-land.js';

const proceed: VerificationDecision = { outcome: 'proceed', reason: 'all 1 verifier passed' };
const block: VerificationDecision = { outcome: 'block', reason: 'verifier command failed' };
const inconclusive: VerificationDecision = { outcome: 'escalate', reason: 'verifier inconclusive' };

/** In-memory {@link EpicLandGit}: branch existence, tip OIDs, and the default
 * (symbolic) branch, plus a call record — the fake-the-injected-slice idiom the
 * merge-train coordinator test uses. */
class FakeGit implements EpicLandGit {
  constructor(
    readonly branches: Set<string> = new Set(['epic/42']),
    private readonly tips: Map<string, string> = new Map([['epic/42', 'oid-epic-42']]),
    private defaultBranch: string | null = 'develop',
  ) {}
  async branchExists(_dir: string, name: string): Promise<boolean> {
    return this.branches.has(name);
  }
  async revParse(_dir: string, rev: string): Promise<string> {
    return this.tips.get(rev) ?? `oid-${rev}`;
  }
  async symbolicBranch(): Promise<string | null> {
    return this.defaultBranch;
  }
  setDefaultBranch(b: string | null): void {
    this.defaultBranch = b;
  }
}

const okLand = (over?: Partial<Extract<LandBranchOutcome, { ok: true }>>): LandBranchOutcome => ({
  ok: true,
  mode: 'cas',
  oid: 'landed-oid',
  baseBranch: 'develop',
  branch: 'epic/42',
  ...over,
});

type VerifyFn = (args: { repoDir: string; candidateOid: string }) => Promise<VerificationDecision>;

const build = (opts: {
  git?: FakeGit;
  verify?: VerifyFn;
  land?: (args: LandBranchArgs) => Promise<LandBranchOutcome>;
  landLeaseHeld?: boolean;
} = {}) => {
  const git = opts.git ?? new FakeGit();
  const verify = vi.fn<VerifyFn>(opts.verify ?? (async () => proceed));
  const land = vi.fn(opts.land ?? (async () => okLand()));
  const retire = vi.fn(async (_ref: number) => {});
  const escalate = vi.fn<(epicRef: number, reason: string) => void>();
  const onError = vi.fn<(msg: string) => void>();
  const coord = new EpicLandCoordinator({
    repoDir: '/repo',
    git,
    verify,
    land,
    retire,
    escalate,
    ...(opts.landLeaseHeld !== undefined ? { landLeaseHeld: opts.landLeaseHeld } : {}),
    onError,
  });
  return { coord, git, verify, land, retire, escalate, onError };
};

const members = (...m: MemberLandState[]): MemberLandState[] => m;

describe('EpicLandCoordinator', () => {
  it('is a noop when the integration branch is gone (already landed/retired)', async () => {
    const { coord, verify, land } = build({ git: new FakeGit(new Set()) });
    const out = await coord.submit({ ref: 42, members: members('completed') });
    expect(out).toEqual({ status: 'noop', reason: expect.any(String) });
    expect(verify).not.toHaveBeenCalled();
    expect(land).not.toHaveBeenCalled();
  });

  it('waits (no verify, no land) while a member is still pending', async () => {
    const { coord, verify, land } = build();
    const out = await coord.submit({ ref: 42, members: members('completed', 'pending') });
    expect(out.status).toBe('waiting');
    expect(verify).not.toHaveBeenCalled();
    expect(land).not.toHaveBeenCalled();
  });

  it('blocks (no verify, no land, no escalate) when a member cannot land', async () => {
    const { coord, verify, land, escalate } = build();
    const out = await coord.submit({ ref: 42, members: members('completed', 'blocked') });
    expect(out.status).toBe('blocked');
    expect(verify).not.toHaveBeenCalled();
    expect(land).not.toHaveBeenCalled();
    expect(escalate).not.toHaveBeenCalled();
  });

  it('lands + retires only when all members completed AND verification proceeds', async () => {
    const { coord, verify, land, retire, escalate } = build();
    const out = await coord.submit({ ref: 42, members: members('completed', 'completed') });
    expect(out).toEqual({ status: 'landed', oid: 'landed-oid' });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ candidateOid: 'oid-epic-42' }));
    expect(land).toHaveBeenCalledWith(expect.objectContaining({ repoDir: '/repo', baseBranch: 'develop', branch: 'epic/42' }));
    expect(retire).toHaveBeenCalledWith(42);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('escalates and never lands when the integrated whole fails verification', async () => {
    const { coord, land, retire, escalate } = build({ verify: async () => block });
    const out = await coord.submit({ ref: 42, members: members('completed') });
    expect(out.status).toBe('escalated');
    expect(land).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('verification'));
  });

  it('escalates on an inconclusive/escalate whole-Epic verdict (fail-safe)', async () => {
    const { coord, land, escalate } = build({ verify: async () => inconclusive });
    const out = await coord.submit({ ref: 42, members: members('completed') });
    expect(out.status).toBe('escalated');
    expect(land).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalled();
  });

  it('escalates (never lands) when the verification harness itself throws', async () => {
    const { coord, land, escalate } = build({
      verify: async () => {
        throw new Error('worktree add failed');
      },
    });
    const out = await coord.submit({ ref: 42, members: members('completed') });
    expect(out.status).toBe('escalated');
    expect(land).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('could not run'));
  });

  it('escalates when the atomic land fails (e.g. fallback-pr-manual with no lease)', async () => {
    const { coord, retire, escalate } = build({
      land: async () => ({ ok: false, reason: 'fallback-pr-manual', detail: 'target checked out, no lease' }),
    });
    const out = await coord.submit({ ref: 42, members: members('completed') });
    expect(out.status).toBe('escalated');
    expect(retire).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledWith(42, expect.stringContaining('fallback-pr-manual'));
  });

  it('defers (waiting, no land) when the default branch is detached', async () => {
    const git = new FakeGit();
    git.setDefaultBranch(null);
    const { coord, land } = build({ git });
    const out = await coord.submit({ ref: 42, members: members('completed') });
    expect(out.status).toBe('waiting');
    expect(land).not.toHaveBeenCalled();
  });

  it('stays landed when retire fails after a successful land (non-fatal, logged)', async () => {
    const onError = vi.fn<(msg: string) => void>();
    const coordWithBadRetire = new EpicLandCoordinator({
      repoDir: '/repo',
      git: new FakeGit(),
      verify: async () => proceed,
      land: async () => okLand(),
      retire: async () => {
        throw new Error('branch -d failed');
      },
      escalate: vi.fn(),
      onError,
    });
    const out = await coordWithBadRetire.submit({ ref: 42, members: members('completed') });
    expect(out.status).toBe('landed');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('retire'));
  });

  it('passes landLeaseHeld through to landBranch', async () => {
    const { coord, land } = build({ landLeaseHeld: true });
    await coord.submit({ ref: 42, members: members('completed') });
    expect(land).toHaveBeenCalledWith(expect.objectContaining({ leaseHeld: true }));
  });

  describe('operator force-land-ready-subset', () => {
    it('lands the subset past a blocked member when verification proceeds', async () => {
      const { coord, land, retire } = build();
      const out = await coord.submit({ ref: 42, members: members('completed', 'blocked') }, { force: true });
      expect(out.status).toBe('landed');
      expect(land).toHaveBeenCalled();
      expect(retire).toHaveBeenCalledWith(42);
    });

    it('still escalates on a failing verification — force does not bypass Verification', async () => {
      const { coord, land, escalate } = build({ verify: async () => block });
      const out = await coord.submit({ ref: 42, members: members('completed', 'blocked') }, { force: true });
      expect(out.status).toBe('escalated');
      expect(land).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalled();
    });

    it('is still a noop with no integration branch to land', async () => {
      const { coord, verify } = build({ git: new FakeGit(new Set()) });
      const out = await coord.submit({ ref: 42, members: [] }, { force: true });
      expect(out.status).toBe('noop');
      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe('sticky escalation (level-trigger terminal guard)', () => {
    it('does not re-run Verification or re-escalate on repeated polls once escalated for the same member state', async () => {
      const { coord, verify, escalate } = build({ verify: async () => block });
      const target = { ref: 42, members: members('completed', 'completed') };
      const first = await coord.submit(target);
      expect(first.status).toBe('escalated');
      // Two more polls with the same member state: no repeated CI burn / escalation.
      const second = await coord.submit(target);
      const third = await coord.submit(target);
      expect(second.status).toBe('escalated');
      expect(third.status).toBe('escalated');
      expect(verify).toHaveBeenCalledTimes(1);
      expect(escalate).toHaveBeenCalledTimes(1);
    });

    it('re-attempts once the member-state signature changes', async () => {
      const { coord, verify } = build({ verify: async () => block });
      await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(verify).toHaveBeenCalledTimes(1);
      // A third member completes: a fresh signature ⇒ Verification runs again.
      await coord.submit({ ref: 42, members: members('completed', 'completed', 'completed') });
      expect(verify).toHaveBeenCalledTimes(2);
    });

    it('clears the hold when the integration branch is gone, then starts clean', async () => {
      const git = new FakeGit(new Set(['epic/42']));
      const { coord, verify } = build({ git, verify: async () => block });
      await coord.submit({ ref: 42, members: members('completed') });
      expect(verify).toHaveBeenCalledTimes(1);
      // Branch retired/hand-landed away → the sticky hold clears (a re-cut Epic reusing the ref is not wrongly held).
      git.branches.delete('epic/42');
      const gone = await coord.submit({ ref: 42, members: members('completed') });
      expect(gone.status).toBe('noop');
      git.branches.add('epic/42');
      await coord.submit({ ref: 42, members: members('completed') });
      expect(verify).toHaveBeenCalledTimes(2);
    });

    it('an operator force-land always retries past a sticky escalation', async () => {
      const { coord, verify, land } = build({
        verify: vi
          .fn<VerifyFn>()
          .mockResolvedValueOnce(block) // auto attempt escalates and sticks
          .mockResolvedValue(proceed), // the forced retry passes
      });
      await coord.submit({ ref: 42, members: members('completed') });
      const forced = await coord.submit({ ref: 42, members: members('completed') }, { force: true });
      expect(forced.status).toBe('landed');
      expect(verify).toHaveBeenCalledTimes(2);
      expect(land).toHaveBeenCalledTimes(1);
    });
  });

  it('short-circuits a concurrent re-submit for the same Epic to busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { coord } = build({
      verify: async () => {
        await gate;
        return proceed;
      },
    });
    const first = coord.submit({ ref: 42, members: members('completed') });
    // A second submit while the first is mid-verification must not start a redundant attempt.
    const second = await coord.submit({ ref: 42, members: members('completed') });
    expect(second).toEqual({ status: 'busy' });
    release();
    expect((await first).status).toBe('landed');
  });
});
