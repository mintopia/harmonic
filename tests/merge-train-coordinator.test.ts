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

type RebaseOutcome =
  | { ok: true; rebasedTip: string }
  | { ok: false; conflict: true; detail: string };

/** An in-memory {@link MergeTrainGit} recording every call, driven entirely by
 * maps the test sets up — mirrors the FakeGit idiom in `tests/epic-integration.test.ts`. */
class FakeGit implements MergeTrainGit {
  /** branch -> current tip oid. Absence means the branch doesn't exist. */
  readonly refs = new Map<string, string>();
  /** member branch -> fixed tip oid. */
  readonly memberTips = new Map<string, string>();
  /** branch -> worktree path it's checked out at, or explicit null. Absent = null. */
  readonly checkouts = new Map<string, string | null>();
  /** worktreeDir -> queue of rebase outcomes, shifted one per call. */
  readonly rebaseOutcomes = new Map<string, RebaseOutcome[]>();
  /** Real DAG edges as `${ancestor}|${descendant}` — `ancestor` is contained
   * in `descendant`'s history. `isAncestor` reads these with git's true
   * asymmetric semantics, so a reversed-argument call is caught, not masked. */
  readonly ancestors = new Set<string>();
  /** branch -> a promise casUpdateRef awaits before applying, for testing
   * that one branch's slow op never blocks another branch. */
  readonly casGate = new Map<string, Promise<void>>();

  readonly branchExistsCalls: string[] = [];
  readonly revParseCalls: string[] = [];
  readonly isAncestorCalls: Array<[string, string]> = [];
  readonly checkedOutCalls: string[] = [];
  readonly rebaseCalls: Array<{ worktreeDir: string; ontoOid: string }> = [];
  readonly casCalls: Array<{ branch: string; newOid: string; expectedOld: string }> = [];

  async branchExists(_dir: string, name: string): Promise<boolean> {
    this.branchExistsCalls.push(name);
    return this.refs.has(name);
  }

  async revParse(_dir: string, rev: string): Promise<string> {
    this.revParseCalls.push(rev);
    if (this.refs.has(rev)) return this.refs.get(rev)!;
    if (this.memberTips.has(rev)) return this.memberTips.get(rev)!;
    throw new Error(`FakeGit.revParse: unknown rev ${rev}`);
  }

  async isAncestor(_dir: string, baseRev: string, rev: string): Promise<boolean> {
    this.isAncestorCalls.push([baseRev, rev]);
    // Git semantics: true iff `rev` is an ancestor-or-equal of `baseRev`.
    return rev === baseRev || this.ancestors.has(`${rev}|${baseRev}`);
  }

  async branchCheckedOutAt(_dir: string, branch: string): Promise<string | null> {
    this.checkedOutCalls.push(branch);
    return this.checkouts.get(branch) ?? null;
  }

  async rebaseOnto(worktreeDir: string, ontoOid: string): Promise<RebaseOutcome> {
    this.rebaseCalls.push({ worktreeDir, ontoOid });
    const queue = this.rebaseOutcomes.get(worktreeDir);
    const next = queue?.shift();
    if (!next) throw new Error(`FakeGit.rebaseOnto: no queued outcome for ${worktreeDir}`);
    return next;
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
    memberWorktreeDir: '/wt/1',
    ...overrides,
  };
}

function collaborators() {
  const dispatchHeal = vi.fn(async () => {});
  const escalate = vi.fn();
  return { dispatchHeal, escalate };
}

describe('MergeTrainCoordinator (issue #160)', () => {
  it('records rebase and fast-forward as children of the member land operation', async () => {
    const exporter = installOperations();
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.rebaseOutcomes.set('/wt/1', [{ ok: true, rebasedTip: 'mem-a-rebased' }]);
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate, operations: new EpicOperations() });

    await coordinator.submit(member());

    const spans = exporter.getFinishedSpans();
    const memberLand = spans.find((span) => span.name === 'harmonic.epic.member-land');
    if (!memberLand) throw new Error('Expected member land operation');
    for (const name of ['harmonic.epic.git.rebase', 'harmonic.epic.git.fast-forward']) {
      const span = spans.find((candidate) => candidate.name === name);
      if (!span) throw new Error(`Expected ${name} operation`);
      expect(span.parentSpanContext?.spanId).toBe(memberLand.spanContext().spanId);
    }
  });

  it('1. a single clean member rebases onto the observed integration tip and lands via CAS', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.rebaseOutcomes.set('/wt/1', [{ ok: true, rebasedTip: 'mem-a-rebased' }]);
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });

    const outcome = await coordinator.submit(member());

    expect(outcome).toEqual({ status: 'landed', oid: 'mem-a-rebased' });
    expect(git.rebaseCalls).toEqual([{ worktreeDir: '/wt/1', ontoOid: 'int-a' }]);
    expect(git.casCalls).toEqual([{ branch: 'epic/1', newOid: 'mem-a-rebased', expectedOld: 'int-a' }]);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('2. two members finishing near-simultaneously on the SAME integration branch land strictly serialised', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-0');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-1');
    git.memberTips.set('harmonic/task-2-run-1', 'mem-2');
    git.rebaseOutcomes.set('/wt/1', [{ ok: true, rebasedTip: 'landed-1' }]);
    git.rebaseOutcomes.set('/wt/2', [{ ok: true, rebasedTip: 'landed-2' }]);
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });

    const m1 = member({ runId: 1, memberBranch: 'harmonic/task-1-run-1', memberWorktreeDir: '/wt/1' });
    const m2 = member({ runId: 2, memberBranch: 'harmonic/task-2-run-1', memberWorktreeDir: '/wt/2' });

    // Submitted without awaiting the first — the coordinator, not the caller,
    // must impose the order.
    const [o1, o2] = await Promise.all([coordinator.submit(m1), coordinator.submit(m2)]);

    expect(o1).toEqual({ status: 'landed', oid: 'landed-1' });
    expect(o2).toEqual({ status: 'landed', oid: 'landed-2' });
    // No interleave: the 2nd member's rebase/CAS observe the 1st's landed oid.
    expect(git.rebaseCalls).toEqual([
      { worktreeDir: '/wt/1', ontoOid: 'int-0' },
      { worktreeDir: '/wt/2', ontoOid: 'landed-1' },
    ]);
    expect(git.casCalls).toEqual([
      { branch: 'epic/1', newOid: 'landed-1', expectedOld: 'int-0' },
      { branch: 'epic/1', newOid: 'landed-2', expectedOld: 'landed-1' },
    ]);
  });

  it('3. members on DIFFERENT integration branches never block each other', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int1-a');
    git.refs.set('epic/2', 'int2-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem1');
    git.memberTips.set('harmonic/task-2-run-1', 'mem2');
    git.rebaseOutcomes.set('/wt/1', [{ ok: true, rebasedTip: 'mem1-rebased' }]);
    git.rebaseOutcomes.set('/wt/2', [{ ok: true, rebasedTip: 'mem2-rebased' }]);

    // Branch epic/1's CAS is gated on a promise the test controls; branch
    // epic/2 has no gate at all.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    git.casGate.set('epic/1', gate);

    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });

    const m1 = member({ runId: 1, integrationBranch: 'epic/1', memberBranch: 'harmonic/task-1-run-1', memberWorktreeDir: '/wt/1' });
    const m2 = member({ runId: 2, integrationBranch: 'epic/2', memberBranch: 'harmonic/task-2-run-1', memberWorktreeDir: '/wt/2' });

    const p1 = coordinator.submit(m1); // blocked mid-flight on epic/1's gate
    const p2 = coordinator.submit(m2); // must complete independently

    const o2 = await p2;
    expect(o2).toEqual({ status: 'landed', oid: 'mem2-rebased' });

    releaseGate();
    const o1 = await p1;
    expect(o1).toEqual({ status: 'landed', oid: 'mem1-rebased' });
  });

  it('4. a conflicting member heals once and then lands', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.rebaseOutcomes.set('/wt/1', [
      { ok: false, conflict: true, detail: 'conflict!' },
      { ok: true, rebasedTip: 'mem-a-healed' },
    ]);
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });
    const m = member();

    const o1 = await coordinator.submit(m);
    expect(o1).toEqual({ status: 'healing' });
    expect(dispatchHeal).toHaveBeenCalledTimes(1);
    expect(dispatchHeal).toHaveBeenCalledWith(m);

    const o2 = await coordinator.onHealComplete(m);
    expect(o2).toEqual({ status: 'landed', oid: 'mem-a-healed' });
    expect(dispatchHeal).toHaveBeenCalledTimes(1); // not called again
    expect(escalate).not.toHaveBeenCalled();
  });

  it('5. a member that still conflicts after the corrective turn escalates without a second heal', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.rebaseOutcomes.set('/wt/1', [
      { ok: false, conflict: true, detail: 'conflict 1' },
      { ok: false, conflict: true, detail: 'conflict 2' },
    ]);
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });
    const m = member();

    const o1 = await coordinator.submit(m);
    expect(o1).toEqual({ status: 'healing' });

    const o2 = await coordinator.onHealComplete(m);
    expect(o2).toEqual({ status: 'escalated', reason: 'rebase still conflicts after corrective turn' });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(m, 'rebase still conflicts after corrective turn');
    expect(dispatchHeal).toHaveBeenCalledTimes(1); // no 2nd mutating turn
    expect(git.casCalls).toEqual([]);
  });

  it('6. already-landed re-submit (idempotency/crash): no rebase, no CAS', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.ancestors.add('mem-a|int-a'); // memberTip already an ancestor of integrationTip
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });

    const outcome = await coordinator.submit(member());

    expect(outcome).toEqual({ status: 'already-landed' });
    expect(git.rebaseCalls).toEqual([]);
    expect(git.casCalls).toEqual([]);
    expect(escalate).not.toHaveBeenCalled();
    expect(dispatchHeal).not.toHaveBeenCalled();
  });

  it('7. escalates when the integration branch is missing, without attempting a rebase or CAS', async () => {
    const git = new FakeGit(); // no refs set at all
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });
    const m = member();

    const outcome = await coordinator.submit(m);

    expect(outcome).toEqual({ status: 'escalated', reason: 'integration branch missing' });
    expect(escalate).toHaveBeenCalledWith(m, 'integration branch missing');
    expect(git.rebaseCalls).toEqual([]);
    expect(git.casCalls).toEqual([]);
  });

  it('8. ff guard: escalates instead of updating the ref when the integration branch is unexpectedly checked out', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.rebaseOutcomes.set('/wt/1', [{ ok: true, rebasedTip: 'mem-a-rebased' }]);
    git.checkouts.set('epic/1', '/some/other/worktree');
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });
    const m = member();

    const outcome = await coordinator.submit(m);

    expect(outcome).toEqual({ status: 'escalated', reason: 'integration branch unexpectedly checked out' });
    expect(escalate).toHaveBeenCalledWith(m, 'integration branch unexpectedly checked out');
    expect(git.casCalls).toEqual([]);
  });

  it('9. heal releases the chain slot: a second ready member on the same branch still lands', async () => {
    const git = new FakeGit();
    git.refs.set('epic/1', 'int-a');
    git.memberTips.set('harmonic/task-1-run-1', 'mem-a');
    git.memberTips.set('harmonic/task-2-run-1', 'mem-b');
    git.rebaseOutcomes.set('/wt/1', [{ ok: false, conflict: true, detail: 'conflict!' }]);
    git.rebaseOutcomes.set('/wt/2', [{ ok: true, rebasedTip: 'mem-b-rebased' }]);
    const { dispatchHeal, escalate } = collaborators();
    const coordinator = new MergeTrainCoordinator({ git, dispatchHeal, escalate });

    const memberA = member({ runId: 1, memberBranch: 'harmonic/task-1-run-1', memberWorktreeDir: '/wt/1' });
    const memberB = member({ runId: 2, memberBranch: 'harmonic/task-2-run-1', memberWorktreeDir: '/wt/2' });

    const oA = await coordinator.submit(memberA);
    expect(oA).toEqual({ status: 'healing' });

    // memberA's corrective turn has NOT completed (onHealComplete never
    // called for it) — the train must not be held waiting for it.
    const oB = await coordinator.submit(memberB);
    expect(oB).toEqual({ status: 'landed', oid: 'mem-b-rebased' });
    expect(git.casCalls).toEqual([{ branch: 'epic/1', newOid: 'mem-b-rebased', expectedOld: 'int-a' }]);
  });
});
