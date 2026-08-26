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
  /** Branch names already contained in (an ancestor of) the default branch —
   * the tier-1 containment fast-path (#218). Empty by default: nothing pre-landed. */
  readonly contained: Set<string> = new Set();
  /** Branch names whose *content* is already in the default branch even though
   * the tip is not an ancestor (a squash/rebase land) — the tier-2 fast-path (#218). */
  readonly contentContained: Set<string> = new Set();
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
  async isAncestor(_dir: string, _baseBranch: string, branch: string): Promise<boolean> {
    return this.contained.has(branch);
  }
  async isContentContained(_dir: string, _baseBranch: string, branch: string): Promise<boolean> {
    return this.contentContained.has(branch);
  }
  setDefaultBranch(b: string | null): void {
    this.defaultBranch = b;
  }
  setContained(branch: string): void {
    this.contained.add(branch);
  }
  setContentContained(branch: string): void {
    this.contentContained.add(branch);
  }
}

const okLand = (over?: Partial<Extract<LandBranchOutcome, { ok: true }>>): LandBranchOutcome => ({
  ok: true,
  mode: 'cas',
  oid: 'landed-oid',
  baseBranch: 'develop',
  branch: 'epic/42',
  rebased: false,
  ...over,
});

type VerifyFn = (args: { repoDir: string; candidateOid: string }) => Promise<VerificationDecision>;

const build = (opts: {
  git?: FakeGit;
  verify?: VerifyFn;
  land?: (args: LandBranchArgs) => Promise<LandBranchOutcome>;
  landLeaseHeld?: boolean;
  now?: () => number;
  verifyBackoffMs?: number;
} = {}) => {
  const git = opts.git ?? new FakeGit();
  const verify = vi.fn<VerifyFn>(opts.verify ?? (async () => proceed));
  const land = vi.fn(opts.land ?? (async () => okLand()));
  const retire = vi.fn(async (_ref: number) => {});
  const escalate = vi.fn<(epicRef: number, reason: string) => void>();
  const onError = vi.fn<(msg: string) => void>();
  // Default clock steps 10min per read so the hard backoff (#218, default 60s)
  // never blocks the many tests that re-submit rapidly; backoff tests inject
  // their own controlled clock.
  let t = 0;
  const coord = new EpicLandCoordinator({
    repoDir: '/repo',
    git,
    verify,
    land,
    retire,
    escalate,
    ...(opts.landLeaseHeld !== undefined ? { landLeaseHeld: opts.landLeaseHeld } : {}),
    now: opts.now ?? (() => (t += 600_000)),
    ...(opts.verifyBackoffMs !== undefined ? { verifyBackoffMs: opts.verifyBackoffMs } : {}),
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

  it('defers (waiting, not escalated) when the land finds the verified tip stale — the next poll re-verifies at the new tips', async () => {
    for (const reason of ['stale-head', 'stale-base', 'target-advanced'] as const) {
      const { coord, retire, escalate } = build({
        land: async () => ({ ok: false, reason, detail: 'moved between verify and land' }),
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out).toMatchObject({ status: 'waiting', reason: expect.stringContaining(reason) });
      expect(retire).not.toHaveBeenCalled();
      expect(escalate).not.toHaveBeenCalled();
    }
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

  it('asserts the exclusive clean lease by default — Harmonic owns its working dir (#218)', async () => {
    const { coord, land } = build();
    await coord.submit({ ref: 42, members: members('completed') });
    expect(land).toHaveBeenCalledWith(expect.objectContaining({ leaseHeld: true }));
  });

  it('passes an explicit landLeaseHeld=false through to landBranch', async () => {
    const { coord, land } = build({ landLeaseHeld: false });
    await coord.submit({ ref: 42, members: members('completed') });
    expect(land).toHaveBeenCalledWith(expect.objectContaining({ leaseHeld: false }));
  });

  describe('containment fast-path (#218)', () => {
    it('retires (no verify, no land) when the integration branch is already contained in the default branch', async () => {
      const git = new FakeGit();
      git.setContained('epic/42');
      const { coord, verify, land, retire } = build({ git });
      const out = await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(out).toEqual({ status: 'landed', oid: 'oid-epic-42' });
      expect(verify).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expect(retire).toHaveBeenCalledWith(42);
    });

    it('stays a success when the retire of an already-contained branch fails (logged, non-fatal)', async () => {
      const git = new FakeGit();
      git.setContained('epic/42');
      const onError = vi.fn<(msg: string) => void>();
      const coord = new EpicLandCoordinator({
        repoDir: '/repo',
        git,
        verify: async () => proceed,
        land: async () => okLand(),
        retire: async () => {
          throw new Error('branch -d failed');
        },
        escalate: vi.fn(),
        onError,
      });
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('landed');
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('already-contained'));
    });

    it('retires a squash/rebase-landed branch whose content is contained but tip is not an ancestor (tier 2, #218)', async () => {
      const git = new FakeGit();
      git.setContentContained('epic/42'); // content in default, but NOT an ancestor
      const { coord, verify, land, retire } = build({ git });
      const out = await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(out).toEqual({ status: 'landed', oid: 'oid-epic-42' });
      expect(verify).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expect(retire).toHaveBeenCalledWith(42);
    });

    it('holds the tier-2 content check behind the backoff (not run every poll)', async () => {
      let clock = 0;
      const git = new FakeGit();
      const isContentContained = vi.spyOn(git, 'isContentContained');
      const { coord } = build({ git, verify: async () => inconclusive, now: () => clock, verifyBackoffMs: 60_000 });
      await coord.submit({ ref: 42, members: members('completed') }); // runs tier 2, then escalates
      expect(isContentContained).toHaveBeenCalledTimes(1);
      clock = 30_000; // inside the window
      await coord.submit({ ref: 42, members: members('completed', 'completed') }); // churn → deferred by backoff
      expect(isContentContained).toHaveBeenCalledTimes(1); // NOT re-run under backoff
    });

    it('keeps the backoff when a contained-branch retire fails, so tier 2 does not re-run every poll (#218)', async () => {
      // Regression: a content-contained branch whose retire keeps failing must
      // stay throttled. If retireContained cleared the backoff, the heavy tier-2
      // merge would re-run every poll — the storm class #218 targets.
      let clock = 0;
      const git = new FakeGit();
      git.setContentContained('epic/42'); // content landed (squash), tip not an ancestor
      const isContentContained = vi.spyOn(git, 'isContentContained');
      const retire = vi.fn(async (_ref: number) => {
        throw new Error('branch -d failed');
      });
      const onError = vi.fn<(msg: string) => void>();
      const coord = new EpicLandCoordinator({
        repoDir: '/repo',
        git,
        verify: async () => proceed,
        land: async () => okLand(),
        retire,
        escalate: vi.fn(),
        now: () => clock,
        verifyBackoffMs: 60_000,
        onError,
      });
      const first = await coord.submit({ ref: 42, members: members('completed') });
      expect(first.status).toBe('landed'); // tier 2 retires (retire throws, logged non-fatal)
      expect(isContentContained).toHaveBeenCalledTimes(1);
      expect(retire).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('already-contained'));
      clock = 30_000; // still inside the backoff window
      const second = await coord.submit({ ref: 42, members: members('completed') });
      expect(second.status).toBe('waiting'); // deferred by the retained backoff
      expect(isContentContained).toHaveBeenCalledTimes(1); // heavy check NOT re-run
      expect(retire).toHaveBeenCalledTimes(1); // no per-poll retire retry storm
    });

    it('retains the last verification verdict on the containment fast-path (read-model consistency, #218)', async () => {
      const git = new FakeGit();
      const { coord } = build({ git });
      // A normal land records verificationStatus='pass' (the default fake retire
      // is a no-op, so the branch lingers). Marking it contained then exercises
      // the fast-path, which must NOT clobber that verdict to null.
      await coord.submit({ ref: 42, members: members('completed') });
      expect(coord.verificationStatus(42)).toBe('pass');
      git.setContained('epic/42');
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out.status).toBe('landed');
      expect(coord.verificationStatus(42)).toBe('pass');
    });

    it('auto-retires an already-contained branch even if it was previously escalated (clears the sticky hold)', async () => {
      const git = new FakeGit();
      const { coord, verify, retire } = build({ git, verify: async () => block });
      // First poll escalates and sticks.
      const first = await coord.submit({ ref: 42, members: members('completed') });
      expect(first.status).toBe('escalated');
      expect(retire).not.toHaveBeenCalled();
      // The work then lands by hand: the branch becomes contained. The next poll
      // retires it rather than staying held forever.
      git.setContained('epic/42');
      const out = await coord.submit({ ref: 42, members: members('completed') });
      expect(out).toEqual({ status: 'landed', oid: 'oid-epic-42' });
      expect(retire).toHaveBeenCalledWith(42);
      expect(verify).toHaveBeenCalledTimes(1); // never re-ran verify
    });
  });

  describe('hard verify+land backoff (#218)', () => {
    // A churning member signature (completed → completed,completed) makes the
    // per-signature sticky-escalation hold miss, so only the ref-keyed backoff
    // stops the second verify+land from re-burning inside the window.
    it('defers a repeat verify+land within the backoff window (no re-burn)', async () => {
      let clock = 0;
      const { coord, verify } = build({ verify: async () => inconclusive, now: () => clock, verifyBackoffMs: 60_000 });
      const first = await coord.submit({ ref: 42, members: members('completed') });
      expect(first.status).toBe('escalated');
      clock = 30_000; // < 60s
      const second = await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(second.status).toBe('waiting');
      expect(verify).toHaveBeenCalledTimes(1);
    });

    it('allows the next verify+land once the backoff window elapses', async () => {
      let clock = 0;
      const { coord, verify } = build({ verify: async () => inconclusive, now: () => clock, verifyBackoffMs: 60_000 });
      await coord.submit({ ref: 42, members: members('completed') });
      clock = 60_001; // past the window
      await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(verify).toHaveBeenCalledTimes(2);
    });

    it('an operator force-land bypasses the backoff', async () => {
      let clock = 0;
      const { coord, verify } = build({
        // First (auto) attempt escalates and records the attempt time; the forced
        // retry inside the window still runs, proving force bypasses the backoff.
        verify: vi.fn<VerifyFn>().mockResolvedValueOnce(inconclusive).mockResolvedValue(proceed),
        now: () => clock,
        verifyBackoffMs: 60_000,
      });
      const first = await coord.submit({ ref: 42, members: members('completed') });
      expect(first.status).toBe('escalated');
      clock = 10_000; // well inside the window
      const forced = await coord.submit({ ref: 42, members: members('completed') }, { force: true });
      expect(forced.status).toBe('landed');
      expect(verify).toHaveBeenCalledTimes(2);
    });
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

  describe('retained verification status (issue #178)', () => {
    it('is null before any attempt', () => {
      const { coord } = build();
      expect(coord.verificationStatus(42)).toBeNull();
    });

    it('is pass after a successful land', async () => {
      const { coord } = build();
      await coord.submit({ ref: 42, members: members('completed', 'completed') });
      expect(coord.verificationStatus(42)).toBe('pass');
    });

    it('is fail after a blocking verdict', async () => {
      const { coord } = build({ verify: async () => block });
      await coord.submit({ ref: 42, members: members('completed') });
      expect(coord.verificationStatus(42)).toBe('fail');
    });

    it('is fail after an inconclusive verdict', async () => {
      const { coord } = build({ verify: async () => inconclusive });
      await coord.submit({ ref: 42, members: members('completed') });
      expect(coord.verificationStatus(42)).toBe('fail');
    });

    it('is fail after the verification harness throws', async () => {
      const { coord } = build({
        verify: async () => {
          throw new Error('boom');
        },
      });
      await coord.submit({ ref: 42, members: members('completed') });
      expect(coord.verificationStatus(42)).toBe('fail');
    });

    it('is pending while a verify is in flight, then pass once it resolves', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { coord } = build({
        verify: async () => {
          await gate;
          return proceed;
        },
      });
      const submitted = coord.submit({ ref: 42, members: members('completed') });
      // Let the pre-verify awaits (branchExists/symbolicBranch/revParse) settle so
      // `attempt` reaches the synchronous `lastVerification.set(..., 'pending')`
      // just before the (still-gated) verify call.
      await new Promise((r) => setTimeout(r, 0));
      expect(coord.verificationStatus(42)).toBe('pending');
      release();
      await submitted;
      expect(coord.verificationStatus(42)).toBe('pass');
    });

    it('clears to null once the integration branch is gone', async () => {
      const git = new FakeGit(new Set(['epic/42']));
      const { coord } = build({ git });
      await coord.submit({ ref: 42, members: members('completed') });
      expect(coord.verificationStatus(42)).toBe('pass');
      git.branches.delete('epic/42');
      await coord.submit({ ref: 42, members: members('completed') });
      expect(coord.verificationStatus(42)).toBeNull();
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
