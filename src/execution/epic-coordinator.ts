import { Git } from './git.js';
import type { MergePolicyOutcome } from './merge-policy.js';
import { decideEpicIntegrate, reduceMemberState, type MemberMergeState } from '../domain/epic-integrate-decision.js';
import type { VerificationDecision } from '../verification/combine.js';
import { logger } from '../logger.js';
import { EpicOperations } from './epic-operations.js';
import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { deriveLeafEpics } from '../domain/epic-derivation.js';
import type { Ticket } from '../tracker/adapter.js';
import { persistedTickets } from '../tracker/persisted.js';
import { mergeIntoBase, type MergeIntoBaseArgs, type MergeIntoBaseOutcome } from './branch-merge.js';
import { withBaseCheckoutLock, withRepoLock } from './repo-lock.js';

export { reduceMemberState };

/** The slice of {@link Git} used by Epic branch lifecycle, refresh, and integration. */
export interface EpicGit {
  branchExists(dir: string, name: string): Promise<boolean>;
  revParse(dir: string, rev: string): Promise<string>;
  /** The default branch the integration branch integrates into, or `null` on a detached HEAD. */
  symbolicBranch(dir: string): Promise<string | null>;
  /** Whether `branch` is already merged into `baseBranch` (an ancestor of its tip). */
  isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean>;
  /** Whether merging `branch` into `baseBranch` adds no net content — the work is
   * already integrated even when a squash/rebase rewrote its commits so the tip is
   * not a literal ancestor. Heavier than {@link isAncestor} (a real 3-way merge). */
  isContentContained(dir: string, baseBranch: string, branch: string): Promise<boolean>;
  createBranch(dir: string, name: string, startPoint: string): Promise<unknown>;
  deleteBranch(dir: string, name: string): Promise<unknown>;
  branchCheckedOutAt(dir: string, branch: string): Promise<string | null>;
}

/** The integration branch Harmonic cuts for an Epic, keyed by its tracker ref. */
export function integrationBranchName(epicRef: number): string {
  return `epic/${epicRef}`;
}

/** The inverse of {@link integrationBranchName}, or `null` for a non-Epic branch. */
export function parseIntegrationBranch(name: string | null | undefined): number | null {
  if (!name) return null;
  const match = /^epic\/(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Run a whole-Epic Verification against the integration branch's tip OID and
 * fold the verifiers' verdicts into a single decision. */
export type EpicVerify = (args: { repoDir: string; verifiedHeadOid: string }) => Promise<VerificationDecision>;

/** Merge the Epic's integration branch into the default branch under the one
 * merge policy: `git merge --no-ff` under the base repo mutex, bounded agentic
 * resolve turns, the deterministic post-merge check, and `git revert -m 1` on red.
 * A moved base is reconciled by the merge commit and never detected, so the
 * outcome is only `merged` or `escalated` (conflict / red post-merge check). */
export type EpicIntegrate = (args: {
  repoDir: string;
  epicRef: number;
  defaultBranch: string;
  integrationBranch: string;
}) => Promise<MergePolicyOutcome>;

/** The retained whole-Epic Verification status for the operator read model:
 * `pending` while a verify is in flight, `pass`/`fail` for the last completed
 * attempt's verdict, `null` when none has run for the current integration branch.
 * In-memory only. */
export type EpicVerificationStatus = 'pass' | 'fail' | 'pending' | null;

/** An Epic offered for a integrate attempt, reduced from the poll's derived Epic and
 * its members' mirrored Task states. */
export interface EpicIntegrateTarget {
  ref: number;
  title?: string;
  /** Each member's reduced merge state. An empty array is only safe under an
   * operator force-integrate (which bypasses the per-member gate); a non-force
   * submit with `[]` decides `noop` and never integrates. */
  members: MemberMergeState[];
  /** The Epic's member refs, snapshotted onto the stored Epic record at integration.
   * Absent ⇒ an empty snapshot. */
  memberRefs?: number[];
}

/** Persist a completed Epic integration onto its stored record: the merge-commit
 * hash (null for a no-op finish where the branch already matched base) and the
 * member-ref snapshot. */
export type EpicRecordIntegration = (input: {
  epicRef: number;
  mergeCommit: string | null;
  memberRefs: number[];
}) => Promise<void>;

export type EpicIntegrateOutcome =
  | { status: 'integrated'; oid: string }
  | { status: 'blocked'; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'escalated'; reason: string }
  | { status: 'noop'; reason: string }
  /** A integrate attempt for this Epic is already in flight; the caller re-submits next poll. */
  | { status: 'busy' };

const STICKY_ESCALATION_HOLD_REASON = 'already escalated for this member state; awaiting operator or a state change';

export class EpicCoordinator {
  private readonly repoDir: string;
  private readonly git: Pick<EpicGit, 'branchExists' | 'revParse' | 'symbolicBranch' | 'isAncestor' | 'isContentContained'>;
  private readonly verify: EpicVerify;
  private readonly integrate: EpicIntegrate;
  private readonly retire: (epicRef: number) => Promise<void>;
  private readonly escalateFn: (epicRef: number, reason: string) => void;
  private readonly onError: (msg: string) => void;
  private readonly operations: EpicOperations;
  private readonly recordIntegrationFn: EpicRecordIntegration | undefined;

  private readonly inFlight = new Set<number>();

  private readonly settledEscalated = new Map<number, string>();

  private readonly lastVerification = new Map<number, Exclude<EpicVerificationStatus, null>>();

  private readonly lastVerifyAttemptAt = new Map<number, number>();

  private readonly now: () => number;
  private readonly verifyBackoffMs: number;

  constructor(deps: {
    /** The base repo owning `epic/<ref>` — the Workspace's working directory. */
    repoDir: string;
    git?: Pick<EpicGit, 'branchExists' | 'revParse' | 'symbolicBranch' | 'isAncestor' | 'isContentContained'>;
    /** Whole-Epic Verification against the integration tip. */
    verify: EpicVerify;
    /** Merge the integration branch into the default branch under the one merge policy. */
    integrate: EpicIntegrate;
    /** Retire the integration branch after a successful integrate. */
    retire: (epicRef: number) => Promise<void>;
    /** Epic-level escalation surface (verify fail/inconclusive or integrate failure). */
    escalate: (epicRef: number, reason: string) => void;
    /** Injected clock for the hard backoff; default `Date.now`. */
    now?: () => number;
    /** Minimum gap between whole-Epic verify+integrate attempts per Epic; default 60s. */
    verifyBackoffMs?: number;
    onError?: (msg: string) => void;
    operations?: EpicOperations;
    /** Persist the integration snapshot onto the stored Epic record; absent ⇒ nothing is recorded. */
    recordIntegration?: EpicRecordIntegration;
  }) {
    this.repoDir = deps.repoDir;
    this.git = deps.git ?? Git;
    this.verify = deps.verify;
    this.integrate = deps.integrate;
    this.retire = deps.retire;
    this.escalateFn = deps.escalate;
    this.now = deps.now ?? (() => Date.now());
    this.verifyBackoffMs = deps.verifyBackoffMs ?? 60_000;
    this.onError = deps.onError ?? logger.error;
    this.operations = deps.operations ?? new EpicOperations();
    this.recordIntegrationFn = deps.recordIntegration;
  }

  /**
   * Attempt a whole-Epic integrate for `target`. `force` is the operator's explicit
   * force-integrate-the-ready-subset override — set only by the operator action,
   * never by the automatic poll trigger. Idempotent and re-entrancy-safe: an
   * in-flight attempt for the same Epic returns `busy`.
   */
  async submit(target: EpicIntegrateTarget, opts?: { force?: boolean }): Promise<EpicIntegrateOutcome> {
    const force = opts?.force ?? false;
    if (this.inFlight.has(target.ref)) return { status: 'busy' };
    this.inFlight.add(target.ref);
    try {
      const existing = this.operations.has({ repoDir: this.repoDir, epicRef: target.ref });
      if (!existing && !(await this.git.branchExists(this.repoDir, integrationBranchName(target.ref)))) {
        return await this.attempt(target, force);
      }
      return await this.operations.run({
        repoDir: this.repoDir,
        epicRef: target.ref,
        epicTitle: target.title,
        type: 'integrate',
        attributes: { 'epic.integration_branch': integrationBranchName(target.ref) },
        work: () => this.attempt(target, force),
      });
    } finally {
      this.inFlight.delete(target.ref);
    }
  }

  private async attempt(target: EpicIntegrateTarget, force: boolean): Promise<EpicIntegrateOutcome> {
    const branch = integrationBranchName(target.ref);
    const integrationExists = await this.git.branchExists(this.repoDir, branch);
    if (!integrationExists) {
      this.forget(target.ref);
    }

    const gate = decideEpicIntegrate({ integrationExists, members: target.members, verification: null, force });
    switch (gate.action) {
      case 'noop':
        this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
        return { status: 'noop', reason: gate.reason };
      case 'wait':
        return { status: 'waiting', reason: gate.reason };
      case 'blocked':
        this.operations.fail({ repoDir: this.repoDir, epicRef: target.ref, reason: gate.reason });
        return { status: 'blocked', reason: gate.reason };
      case 'verify':
        break;
      default:
        return { status: 'noop', reason: gate.reason };
    }

    const defaultBranch = await this.git.symbolicBranch(this.repoDir);
    if (defaultBranch === null) {
      return { status: 'waiting', reason: 'default branch is detached; deferring the integrate' };
    }

    if (await this.git.isAncestor(this.repoDir, defaultBranch, branch)) {
      return await this.retireContained(target, branch);
    }

    if (!force && this.settledEscalated.get(target.ref) === this.signatureOf(target.members)) {
      return { status: 'escalated', reason: STICKY_ESCALATION_HOLD_REASON };
    }

    if (!force) {
      const at = this.now();
      const last = this.lastVerifyAttemptAt.get(target.ref);
      if (last !== undefined && at - last < this.verifyBackoffMs) {
        return { status: 'waiting', reason: 'whole-Epic verify+integrate backoff active; deferring this poll' };
      }
      this.lastVerifyAttemptAt.set(target.ref, at);
    }

    if (await this.git.isContentContained(this.repoDir, defaultBranch, branch)) {
      return await this.retireContained(target, branch);
    }

    const verifiedHeadOid = await this.git.revParse(this.repoDir, branch);
    this.lastVerification.set(target.ref, 'pending');
    let verification: VerificationDecision;
    try {
      verification = await this.operations.run({
        repoDir: this.repoDir,
        epicRef: target.ref,
        epicTitle: target.title,
        type: 'verify',
        attributes: { 'git.verified_head_oid': verifiedHeadOid },
        work: () => this.verify({ repoDir: this.repoDir, verifiedHeadOid }),
      });
    } catch (err) {
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, `whole-Epic verification could not run: ${err instanceof Error ? err.message : String(err)}`);
    }

    const verdict = decideEpicIntegrate({ integrationExists: true, members: target.members, verification, force });
    if (verdict.action === 'escalate') {
      this.lastVerification.set(target.ref, 'fail');
      return this.escalate(target, force, verdict.reason);
    }
    if (verdict.action !== 'integrate') {
      this.onError(`epic ${target.ref} unexpected post-verification decision: ${verdict.action}`);
      return { status: 'noop', reason: `unexpected post-verification decision: ${verdict.action}` };
    }

    this.lastVerification.set(target.ref, 'pass');

    const integrated = await this.operations.run({
      repoDir: this.repoDir,
      epicRef: target.ref,
      epicTitle: target.title,
      type: 'merge',
      attributes: { 'git.base_branch': defaultBranch, 'git.branch': branch },
      work: () => this.integrate({ repoDir: this.repoDir, epicRef: target.ref, defaultBranch, integrationBranch: branch }),
    });
    if (integrated.kind === 'escalated') {
      return this.escalate(target, force, `whole-Epic integrate into '${defaultBranch}' failed (${integrated.reason}): ${integrated.message}`);
    }

    const recorded = await this.recordIntegrationQuietly(target, integrated.mergeOid);

    this.clearMergeGuards(target.ref);
    if (recorded) await this.retireQuietly(target.ref, target.title, 'after integrate');
    this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
    return { status: 'integrated', oid: integrated.mergeOid };
  }

  /** Whether `epicRef` currently has a integrate attempt in flight. */
  isInFlight(epicRef: number): boolean {
    return this.inFlight.has(epicRef);
  }

  /** The last retained whole-Epic Verification status for `epicRef`. */
  verificationStatus(epicRef: number): EpicVerificationStatus {
    return this.lastVerification.get(epicRef) ?? null;
  }

  /** Record that `epicRef`'s integration branch has fallen behind develop and a
   * refresh could not fast-forward it. A moving base is normal, never a failure:
   * logged quietly and retried on the next trigger, never raised as an operator hold. */
  recordRefreshBehind(epicRef: number, reason: string): void {
    logger.debug(`epic ${epicRef} integration refresh behind develop (retrying): ${reason}`);
  }

  /** The hold reason if `epicRef` is currently held by the sticky-escalation guard, else `null`. */
  heldReason(epicRef: number): string | null {
    return this.settledEscalated.has(epicRef) ? STICKY_ESCALATION_HOLD_REASON : null;
  }

  /** The integration branch's existence and tip OID for `epicRef`; `tip:null` when the branch is absent. */
  async integrationFacts(epicRef: number): Promise<{ exists: boolean; tip: string | null }> {
    const branch = integrationBranchName(epicRef);
    const exists = await this.git.branchExists(this.repoDir, branch);
    if (!exists) return { exists: false, tip: null };
    const tip = await this.git.revParse(this.repoDir, branch);
    return { exists: true, tip };
  }

  private escalate(target: EpicIntegrateTarget, force: boolean, reason: string): EpicIntegrateOutcome {
    if (!force) this.settledEscalated.set(target.ref, this.signatureOf(target.members));
    this.escalateFn(target.ref, reason);
    this.operations.fail({ repoDir: this.repoDir, epicRef: target.ref, reason });
    return { status: 'escalated', reason };
  }

  private signatureOf(members: MemberMergeState[]): string {
    return [...members].sort().join(',');
  }

  private forget(ref: number): void {
    this.settledEscalated.delete(ref);
    this.lastVerification.delete(ref);
    this.lastVerifyAttemptAt.delete(ref);
  }

  private clearMergeGuards(ref: number): void {
    this.settledEscalated.delete(ref);
    this.lastVerifyAttemptAt.delete(ref);
  }

  private async retireContained(target: EpicIntegrateTarget, branch: string): Promise<EpicIntegrateOutcome> {
    const tip = await this.git.revParse(this.repoDir, branch);
    this.settledEscalated.delete(target.ref);
    const recorded = await this.recordIntegrationQuietly(target, null);
    if (recorded) await this.retireQuietly(target.ref, target.title, 'already-contained');
    this.operations.complete({ repoDir: this.repoDir, epicRef: target.ref });
    return { status: 'integrated', oid: tip };
  }

  private async recordIntegrationQuietly(target: EpicIntegrateTarget, mergeCommit: string | null): Promise<boolean> {
    try {
      await this.recordIntegrationFn?.({ epicRef: target.ref, mergeCommit, memberRefs: target.memberRefs ?? [] });
      return true;
    } catch (err) {
      this.onError(`epic ${target.ref} integration snapshot record failed (deferring branch retire): ${String(err)}`);
      return false;
    }
  }

  private async retireQuietly(ref: number, title: string | undefined, context: string): Promise<void> {
    try {
      await this.operations.run({
        repoDir: this.repoDir,
        epicRef: ref,
        epicTitle: title,
        type: 'retire',
        work: () => this.retire(ref),
      });
    } catch (err) {
      this.onError(`epic ${ref} integration branch retire (${context}) failed: ${String(err)}`);
    }
  }
}

/** A live integration branch that must follow one observed default-branch advance. */
export interface EpicRefreshTarget {
  ref: number;
  repoDir: string;
  defaultBranch: string;
}

export type EpicRefreshOutcome =
  | { status: 'refreshed'; oid: string }
  | { status: 'resolving'; detail: string }
  | { status: 'deferred'; reason: string }
  | { status: 'escalated'; reason: string };

export type EpicRefreshResolveDispatchOutcome =
  | { status: 'dispatched' }
  | { status: 'escalated'; reason: string };

/** Refreshes a live integration branch after the default branch advances. */
export class EpicRefresh {
  private readonly resolving = new Set<number>();

  constructor(private readonly deps: {
    git?: Pick<EpicGit, 'revParse'>;
    merge?: (args: MergeIntoBaseArgs) => Promise<MergeIntoBaseOutcome>;
    dispatchResolve: (target: EpicRefreshTarget, detail: string) => Promise<EpicRefreshResolveDispatchOutcome>;
    escalate: (epicRef: number, reason: string) => void;
  }) {}

  refresh(target: EpicRefreshTarget): Promise<EpicRefreshOutcome> {
    const branch = integrationBranchName(target.ref);
    return withBaseCheckoutLock(target.repoDir, async () => {
      const expectedOid = await (this.deps.git ?? Git).revParse(target.repoDir, target.defaultBranch);
      const outcome = await withRepoLock(target.repoDir, () =>
        (this.deps.merge ?? mergeIntoBase)({
          repoDir: target.repoDir,
          baseBranch: branch,
          branch: target.defaultBranch,
          expectedOid,
          mode: 'merge',
          mutexHeld: true,
        }),
      );
      if (outcome.ok) {
        this.resolving.delete(target.ref);
        return { status: 'refreshed', oid: outcome.oid };
      }
      if (outcome.reason === 'fallback-pr-manual' || outcome.reason === 'target-advanced') {
        return { status: 'deferred', reason: outcome.detail };
      }
      if (outcome.reason !== 'conflict') {
        const reason = `integration refresh failed: ${outcome.detail}`;
        this.resolving.delete(target.ref);
        this.deps.escalate(target.ref, reason);
        return { status: 'escalated', reason };
      }
      if (this.resolving.has(target.ref)) {
        const reason = `integration refresh still conflicts after corrective turn: ${outcome.detail}`;
        this.resolving.delete(target.ref);
        this.deps.escalate(target.ref, reason);
        return { status: 'escalated', reason };
      }
      const dispatch = await this.deps.dispatchResolve(target, outcome.detail);
      if (dispatch.status === 'escalated') return dispatch;
      this.resolving.add(target.ref);
      return { status: 'resolving', detail: outcome.detail };
    });
  }
}

const PRE_SPAWN: ReadonlySet<string> = new Set(['draft', 'ready']);

export interface EpicIntegrateTrigger {
  submit(target: EpicIntegrateTarget, opts?: { force?: boolean }): Promise<unknown>;
}

export interface EpicRefreshTrigger {
  refresh(target: EpicRefreshTarget): Promise<EpicRefreshOutcome>;
}

/** Coordinates integration-branch creation, task bases, and poll-time triggers. */
export class EpicLifecycle {
  private readyMemberRefs = new Set<number>();
  private leafEpicRefs = new Set<number>();
  private latestTickets: Ticket[] = [];
  private operations = new EpicOperations();

  constructor(
    private readonly tasks: TaskService,
    private readonly workingDir: string,
    private readonly git: Pick<EpicGit, 'symbolicBranch' | 'branchExists' | 'createBranch' | 'deleteBranch' | 'branchCheckedOutAt' | 'isAncestor'> = Git,
    private readonly onError: (msg: string) => void = logger.error,
    private epicIntegrate?: EpicIntegrateTrigger,
    private epicRefresh?: EpicRefreshTrigger,
  ) {}

  attachIntegrateTrigger(trigger: EpicIntegrateTrigger): void {
    this.epicIntegrate = trigger;
  }

  attachRefreshTrigger(trigger: EpicRefreshTrigger): void {
    this.epicRefresh = trigger;
  }

  attachOperations(operations: EpicOperations): void {
    this.operations = operations;
  }

  async refreshAfterDefaultBranchAdvance(defaultBranch: string): Promise<void> {
    if (!this.epicRefresh) return;
    const tickets = this.latestTickets.length > 0
      ? this.latestTickets
      : await persistedTickets(await this.tasks.list(), await this.tasks.listTrackerContainers());
    await this.refreshDriftedEpics(defaultBranch, deriveLeafEpics(tickets));
  }

  private async refreshDriftedEpics(defaultBranch: string, epics: readonly { ref: number }[]): Promise<void> {
    if (!this.epicRefresh) return;
    for (const epic of epics) {
      const branch = integrationBranchName(epic.ref);
      if (!(await this.git.branchExists(this.workingDir, branch))) continue;
      if (await this.git.isAncestor(this.workingDir, defaultBranch, branch)) continue;
      try {
        const outcome = await this.epicRefresh.refresh({ ref: epic.ref, repoDir: this.workingDir, defaultBranch });
        if (outcome.status !== 'refreshed') {
          const why = 'reason' in outcome ? outcome.reason : outcome.detail;
          logger.warn(`epic ${epic.ref} still behind ${defaultBranch} after refresh: ${outcome.status} (${why})`);
        }
      } catch (err) {
        this.onError(`epic ${epic.ref} integration refresh failed: ${String(err)}`);
      }
    }
  }

  async reconcile(tickets: Ticket[], mirrored: TaskRow[]): Promise<void> {
    this.latestTickets = tickets;
    const mirroredWithDeps = mirrored.length > 0 ? await this.tasks.listWithDeps({ workspaceId: mirrored[0]!.workspaceId ?? undefined }) : [];
    const readinessByRef = new Map<number, { agentWorkable: boolean }>();
    for (const task of mirroredWithDeps) {
      if (task.origin === 'mirrored' && task.trackerRef !== null) readinessByRef.set(task.trackerRef, { agentWorkable: task.agentWorkable });
    }
    const epics = deriveLeafEpics(tickets, readinessByRef);
    this.leafEpicRefs = new Set(epics.map((epic) => epic.ref));
    const readyRefs = new Set<number>();
    for (const epic of epics) for (const ref of epic.ready) readyRefs.add(ref);
    this.readyMemberRefs = readyRefs;

    let cachedDefault: string | null | undefined;
    const defaultBranchOnce = async (): Promise<string | null> => {
      if (cachedDefault === undefined) cachedDefault = await this.git.symbolicBranch(this.workingDir);
      return cachedDefault;
    };
    if (this.epicRefresh) {
      const defaultBranch = await defaultBranchOnce();
      if (defaultBranch !== null) await this.refreshDriftedEpics(defaultBranch, epics);
    }
    if (readyRefs.size === 0 && this.epicIntegrate === undefined) return;

    const byRef = new Map<number, TaskRow>();
    for (const task of mirrored) if (task.trackerRef != null) byRef.set(task.trackerRef, task);
    const defaultBranch = await defaultBranchOnce();
    if (defaultBranch === null) return;

    for (const epic of epics) {
      if (epic.ready.length > 0) {
        const branch = integrationBranchName(epic.ref);
        try {
          await this.operations.run({
            repoDir: this.workingDir,
            epicRef: epic.ref,
            epicTitle: epic.title,
            type: 'cut',
            attributes: { 'epic.integration_branch': branch },
            work: () => this.ensureIntegrationBranch(branch, defaultBranch),
          });
          for (const memberRef of epic.ready) {
            const task = byRef.get(memberRef);
            if (!task) continue;
            const live = await this.tasks.get(task.id);
            if (PRE_SPAWN.has(live.state) && live.baseBranch !== branch) await this.tasks.setBaseBranch(live.id, branch);
          }
        } catch (err) {
          const reason = `integration branch reconcile failed: ${String(err)}`;
          this.operations.fail({ repoDir: this.workingDir, epicRef: epic.ref, reason });
          this.onError(`epic ${epic.ref} ${reason}`);
        }
      }
      if (this.epicIntegrate) {
        const members = await Promise.all(epic.members.map(async (ref) => {
          const task = byRef.get(ref);
          return reduceMemberState(task ? await this.tasks.get(task.id) : undefined);
        }));
        void this.epicIntegrate.submit({ ref: epic.ref, title: epic.title, members, memberRefs: epic.members })
          .catch((err) => this.onError(`epic ${epic.ref} whole-Epic integrate attempt failed: ${String(err)}`));
      }
    }
  }

  membersOf(epicRef: number): number[] {
    return deriveLeafEpics(this.latestTickets).find((epic) => epic.ref === epicRef)?.members ?? [];
  }

  awaitsBase(task: TaskRow): boolean {
    return task.origin === 'mirrored' && task.baseBranch == null && task.trackerRef != null && this.readyMemberRefs.has(task.trackerRef);
  }

  async memberBaseNotReady(task: TaskRow): Promise<boolean> {
    if (task.origin !== 'mirrored') return false;
    if (this.awaitsBase(task)) return true;
    const epicRef = task.mapRef ?? parseIntegrationBranch(task.baseBranch);
    if (epicRef === null) return false;
    const branch = integrationBranchName(epicRef);
    try {
      const exists = await this.git.branchExists(this.workingDir, branch);
      if (task.baseBranch === branch) return !exists;
      if (exists) return true;
      return await this.isLeafEpic(epicRef, task.workspaceId);
    } catch (err) {
      this.onError(`epic ${epicRef} integration branch existence check failed: ${String(err)}`);
      return true;
    }
  }

  private async isLeafEpic(epicRef: number, workspaceId: number | null): Promise<boolean> {
    if (this.leafEpicRefs.has(epicRef)) return true;
    const listArg = workspaceId == null ? undefined : { workspaceId };
    const tickets = await persistedTickets(
      await this.tasks.list(listArg),
      await this.tasks.listTrackerContainers(workspaceId ?? undefined),
    );
    this.leafEpicRefs = new Set(deriveLeafEpics(tickets).map((epic) => epic.ref));
    return this.leafEpicRefs.has(epicRef);
  }

  private async ensureIntegrationBranch(branch: string, defaultBranch: string): Promise<void> {
    if (await this.git.branchExists(this.workingDir, branch)) return;
    await this.git.createBranch(this.workingDir, branch, defaultBranch);
  }

  async retireIntegrationBranch(epicRef: number): Promise<void> {
    const branch = integrationBranchName(epicRef);
    const defaultBranch = await this.git.symbolicBranch(this.workingDir);
    if (defaultBranch === null || !(await this.git.branchExists(this.workingDir, branch))) return;
    if ((await this.git.branchCheckedOutAt(this.workingDir, branch)) !== null) return;
    if (!(await this.git.isAncestor(this.workingDir, defaultBranch, branch))) return;
    await this.git.deleteBranch(this.workingDir, branch);
  }
}
