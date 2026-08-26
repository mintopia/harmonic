import { afterEach, describe, it, expect, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { EpicOperations } from '../src/execution/epic-operations.js';
import { OperationRegistry } from '../src/telemetry/operations.js';
import {
  MergeTrainCoordinator,
  type MergeTrainGit,
  type MergeTrainMember,
} from '../src/execution/merge-train-coordinator.js';

const providers: NodeTracerProvider[] = [];

afterEach(async () => {
  trace.disable();
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
});

function installOperations() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new OperationRegistry(), new SimpleSpanProcessor(exporter)] });
  provider.register();
  providers.push(provider);
  return exporter;
}

/** An in-memory {@link MergeTrainGit} recording every call, driven entirely by
 * maps the test sets up — mirrors the FakeGit idiom in `tests/epic-integration.test.ts`. */
class FakeGit implements MergeTrainGit {
  /** branch -> current tip oid. Absence means the branch doesn't exist. */
  readonly refs = new Map<string, string>();
  /** member branch -> tip oid. */
  readonly memberTips = new Map<string, string>();
  /** branch -> worktree path it's checked out at, or explicit null. Absent = null. */
  readonly checkouts = new Map<string, string | null>();
  /** Real DAG edges as `${ancestor}|${descendant}` — `ancestor` is contained
   * in `descendant`'s history. `isAncestor` reads these with git's true
   * asymmetric semantics, so a reversed-argument call is caught, not masked. */
  readonly ancestors = new Set<string>();
  /** branch -> a promise casUpdateRef awaits before applying, for testing
   * that one branch's slow op never blocks another branch. */
  readonly casGate = new Map<string, Promise<void>>();

  readonly casCalls: Array<{ branch: string; newOid: string; expectedOld: string }> = [];

  async branchExists(_dir: string, name: string): Promise<boolean> {
    return this.refs.has(name);
  }

  async revParse(_dir: string, rev: string): Promise<string> {
    if (this.refs.has(rev)) return this.refs.get(rev)!;
    if (this.memberTips.has(rev)) return this.memberTips.get(rev)!;
    throw new Error(`FakeGit.revParse: unknown rev ${rev}`);
  }

  async isAncestor(_dir: string, baseRev: string, rev: string): Promise<boolean> {
    // Git semantics: true iff `rev` is an ancestor-or-equal of `baseRev`.
    return rev === baseRev || this.ancestors.has(`${rev}|${baseRev}`);
  }

  async branchCheckedOutAt(_dir: string, branch: string): Promise<string | null> {
    return this.checkouts.get(branch) ?? null;
  }

  async casUpdateRef(
    _dir: string,
    branch: string,
    newOid: string,
    expectedOld: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    const gate = this.casGate.get(branch);
    if (gate) await gate;
    this.casCalls.push({ branch, newOid, expectedOld });
    const current = this.refs.get(branch);
    if (current !== expectedOld) {
      return { ok: false, detail: `expected ${expectedOld}, integration tip is ${current}` };
    }
    this.refs.set(branch, newOid);
    return { ok: true };
  }
}

function member(overrides: Partial<MergeTrainMember> = {}): MergeTrainMember {
  return {
    runId: 1,
    taskId: 1,
    repoDir: '/repo',
    integrationBranch: 'epic/1',
    memberBranch: 'harmonic/task-1-run-1',
    verifiedTip: 'mem-a',
    ...overrides,
  };
}

/** A member branch at `tip`, verified there and based on `integrationTip`. */
function freshMember(git: FakeGit, branch: string, tip: string, integrationTip: string, overrides: Partial<MergeTrainMember> = {}) {
  git.memberTips.set(branch, tip);
  git.ancestors.add(`${integrationTip}|${tip}`);
  return member({ memberBranch: branch, verifiedTip: tip, ...overrides });
}

describe('MergeTrainCoordinator (issue #160, ADR-0041 freshness gate)', () => {
  it('records the fast-forward as a child of the member land operation', async () => {
    const exporter = installOperations();
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate, operations: new EpicOperations() });

    await coordinator.submit(freshMember(git, 'harmonic/task-1-run-1', 'mem-a', 'int-a'));

    const spans = exporter.getFinishedSpans();
    const memberLand = spans.find((span) => span.name === 'harmonic.epic.member-land');
    if (!memberLand) throw new Error('Expected member land operation');
    const ff = spans.find((candidate) => candidate.name === 'harmonic.epic.git.fast-forward');
    if (!ff) throw new Error('Expected fast-forward operation');
    expect(ff.parentSpanContext?.spanId).toBe(memberLand.spanContext().spanId);
  });

  it('1. a fresh member lands via CAS to exactly its verified tip', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });

    const outcome = await coordinator.submit(freshMember(git, 'harmonic/task-1-run-1', 'mem-a', 'int-a'));

    expect(outcome).toEqual({ status: 'landed', oid: 'mem-a' });
    expect(git.casCalls).toEqual([{ branch: 'epic/1', newOid: 'mem-a', expectedOld: 'int-a' }]);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('2. two members verified against the SAME tip land strictly serialised: the first lands, the second is stale', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-0');
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });

    const m1 = freshMember(git, 'harmonic/task-1-run-1', 'mem-1', 'int-0', { runId: 1 });
    const m2 = freshMember(git, 'harmonic/task-2-run-1', 'mem-2', 'int-0', { runId: 2 });

    // Submitted without awaiting the first — the coordinator, not the caller,
    // must impose the order.
    const [o1, o2] = await Promise.all([coordinator.submit(m1), coordinator.submit(m2)]);

    expect(o1).toEqual({ status: 'landed', oid: 'mem-1' });
    // mem-2 was verified against int-0, which mem-1's land has moved past: it
    // must re-enter rebase+verify rather than land a tree nobody verified.
    expect(o2).toEqual({ status: 'stale', reason: 'integration branch advanced after verification' });
    expect(git.casCalls).toEqual([{ branch: 'epic/1', newOid: 'mem-1', expectedOld: 'int-0' }]);

    // Rebased onto mem-1 and re-verified there, the resubmission lands.
    const m2b = freshMember(git, 'harmonic/task-2-run-1', 'mem-2-rebased', 'mem-1', { runId: 2 });
    expect(await coordinator.submit(m2b)).toEqual({ status: 'landed', oid: 'mem-2-rebased' });
    expect(git.refs.get('epic/1')).toBe('mem-2-rebased');
  });

  it('3. members on DIFFERENT integration branches never block each other', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int1-a');
    git.refs.set('epic/2', 'int2-a');

    // Branch epic/1's CAS is gated on a promise the test controls; branch
    // epic/2 has no gate at all.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    git.casGate.set('epic/1', gate);

    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });

    const m1 = freshMember(git, 'harmonic/task-1-run-1', 'mem1', 'int1-a', { runId: 1, integrationBranch: 'epic/1' });
    const m2 = freshMember(git, 'harmonic/task-2-run-1', 'mem2', 'int2-a', { runId: 2, integrationBranch: 'epic/2' });

    const p1 = coordinator.submit(m1); // blocked mid-flight on epic/1's gate
    const p2 = coordinator.submit(m2); // must complete independently

    expect(await p2).toEqual({ status: 'landed', oid: 'mem2' });

    releaseGate();
    expect(await p1).toEqual({ status: 'landed', oid: 'mem1' });
  });

  it('4. a member whose branch moved off its verified tip is stale, with no CAS and no escalate', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    const m = freshMember(git, 'harmonic/task-1-run-1', 'mem-a', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-later');
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });

    expect(await coordinator.submit(m)).toEqual({ status: 'stale', reason: 'member branch moved after verification' });
    expect(git.casCalls).toEqual([]);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('5. a stale member releases the chain slot: a fresh member behind it on the same branch still lands', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    const stale = member({ runId: 1, memberBranch: 'harmonic/task-1-run-1', verifiedTip: 'mem-a' });
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a'); // verified against an older tip: not based on int-a
    const fresh = freshMember(git, 'harmonic/task-2-run-1', 'mem-b', 'int-a', { runId: 2 });
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });

    const [oA, oB] = await Promise.all([coordinator.submit(stale), coordinator.submit(fresh)]);
    expect(oA).toEqual({ status: 'stale', reason: 'integration branch advanced after verification' });
    expect(oB).toEqual({ status: 'landed', oid: 'mem-b' });
    expect(git.casCalls).toEqual([{ branch: 'epic/1', newOid: 'mem-b', expectedOld: 'int-a' }]);
  });

  it('6. already-landed re-submit (idempotency/crash): no CAS', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.ancestors.add('mem-a|int-a'); // memberTip already an ancestor of integrationTip
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });

    expect(await coordinator.submit(member())).toEqual({ status: 'already-landed' });
    expect(git.casCalls).toEqual([]);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('7. escalates when the integration branch is missing, without attempting a CAS', async () => {
    const git = new FakeGit(); // no refs set at all
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });
    const m = member();

    expect(await coordinator.submit(m)).toEqual({ status: 'escalated', reason: 'integration branch missing' });
    expect(escalate).toHaveBeenCalledWith(m, 'integration branch missing');
    expect(git.casCalls).toEqual([]);
  });

  it('8. ff guard: escalates instead of updating the ref when the integration branch is unexpectedly checked out', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.checkouts.set('epic/1', '/some/other/worktree');
    const escalate = vi.fn();
    const coordinator = new MergeTrainCoordinator({ git, escalate });
    const m = freshMember(git, 'harmonic/task-1-run-1', 'mem-a', 'int-a');

    expect(await coordinator.submit(m)).toEqual({ status: 'escalated', reason: 'integration branch unexpectedly checked out' });
    expect(escalate).toHaveBeenCalledWith(m, 'integration branch unexpectedly checked out');
    expect(git.casCalls).toEqual([]);
  });
});
