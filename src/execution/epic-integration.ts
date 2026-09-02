import type { TaskRow } from '../db/schema.js';
import type { TaskService } from '../domain/tasks.js';
import { deriveLeafEpics } from '../domain/epic-derivation.js';
import { reduceMemberState, type MemberMergeState } from '../domain/epic-integrate-decision.js';
import type { Ticket } from '../tracker/adapter.js';
import { persistedTickets } from '../tracker/persisted.js';
import { Git } from './git.js';
import { logger } from '../logger.js';
import { EpicOperations } from './epic-operations.js';

export { reduceMemberState };

/** The integration branch Harmonic cuts for an Epic: `epic/<ref>`, keyed on the Epic ticket's tracker ref. */
export function integrationBranchName(epicRef: number): string {
  return `epic/${epicRef}`;
}

/**
 * The inverse of {@link integrationBranchName}: the Epic ref a branch name
 * encodes, or `null` when `name` is not an integration branch.
 */
export function parseIntegrationBranch(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /^epic\/(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** The slice of {@link Git} the coordinator needs — real Git in prod, a fake in tests. */
export interface EpicGit {
  /** The branch HEAD points at, or `null` on a detached HEAD (never the literal `HEAD`). */
  symbolicBranch(dir: string): Promise<string | null>;
  branchExists(dir: string, name: string): Promise<boolean>;
  createBranch(dir: string, name: string, startPoint: string): Promise<unknown>;
  deleteBranch(dir: string, name: string): Promise<unknown>;
  branchCheckedOutAt(dir: string, branch: string): Promise<string | null>;
  isAncestor(dir: string, baseBranch: string, branch: string): Promise<boolean>;
}

const PRE_SPAWN: ReadonlySet<string> = new Set(['draft', 'ready']);

/**
 * The whole-Epic integrate trigger the reconcile fires per derived Epic each
 * poll. `submit` is a level trigger: harmless to call every poll.
 */
export interface EpicIntegrateTrigger {
  submit(target: { ref: number; members: MemberMergeState[]; memberRefs?: number[] }, opts?: { force?: boolean }): Promise<unknown>;
}

/** Edge-triggered default-branch refresh hook. */
export interface EpicRefreshTrigger {
  refresh(target: { ref: number; repoDir: string; defaultBranch: string }): Promise<unknown>;
}

/**
 * The per-Epic integration-branch lifecycle, owned by Harmonic. Once per poll,
 * {@link reconcile} derives the leaf-most Epics, ensures each ready Epic's
 * integration branch exists, points each ready member's mirrored Task at it via
 * `baseBranch`, gates picks until then, and offers the Epic for whole-Epic
 * integrate. No agent creates or switches the branch.
 */
export class EpicIntegrationCoordinator {
  private readyMemberRefs = new Set<number>();
  private leafEpicRefs = new Set<number>();
  private latestTickets: Ticket[] = [];
  private operations = new EpicOperations();

  constructor(
    private readonly tasks: TaskService,
    private readonly workingDir: string,
    private readonly git: EpicGit = Git,
    private readonly onError: (msg: string) => void = logger.error,
    /** The whole-Epic integrate trigger. Absent ⇒ no automatic integrate. */
    private epicIntegrate?: EpicIntegrateTrigger,
    private epicRefresh?: EpicRefreshTrigger,
  ) {}

  /** Attach (or replace) the whole-Epic integrate trigger after construction. */
  attachIntegrateTrigger(trigger: EpicIntegrateTrigger): void {
    this.epicIntegrate = trigger;
  }

  attachRefreshTrigger(trigger: EpicRefreshTrigger): void {
    this.epicRefresh = trigger;
  }

  /** Handle one observed default-branch advance from Harmonic's own merge path — the edge trigger. */
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
        await this.epicRefresh.refresh({ ref: epic.ref, repoDir: this.workingDir, defaultBranch });
      } catch (err) {
        this.onError(`epic ${epic.ref} integration refresh failed: ${String(err)}`);
      }
    }
  }

  attachOperations(operations: EpicOperations): void {
    this.operations = operations;
  }

  async reconcile(tickets: Ticket[], mirrored: TaskRow[]): Promise<void> {
    this.latestTickets = tickets;
    const mirroredWithDeps = mirrored.length > 0 ? await this.tasks.listWithDeps({ workspaceId: mirrored[0]!.workspaceId ?? undefined }) : [];
    const readinessByRef = new Map<number, { agentWorkable: boolean }>();
    for (const task of mirroredWithDeps) {
      if (task.origin === 'mirrored' && task.trackerRef !== null) {
        readinessByRef.set(task.trackerRef, { agentWorkable: task.agentWorkable });
      }
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
    for (const task of mirrored) {
      if (task.trackerRef != null) byRef.set(task.trackerRef, task);
    }
    const defaultBranch = await defaultBranchOnce();
    if (defaultBranch === null) {
      return;
    }

    for (const epic of epics) {
      if (epic.ready.length > 0) {
        const branch = integrationBranchName(epic.ref);
        try {
          await this.operations.run({
            repoDir: this.workingDir,
            epicRef: epic.ref,
            type: 'cut',
            attributes: { 'epic.integration_branch': branch },
            work: () => this.ensureIntegrationBranch(branch, defaultBranch),
          });
          for (const memberRef of epic.ready) {
            const task = byRef.get(memberRef);
            if (!task) continue;
            const live = await this.tasks.get(task.id);
            if (PRE_SPAWN.has(live.state) && live.baseBranch !== branch) {
              await this.tasks.setBaseBranch(live.id, branch);
            }
          }
        } catch (err) {
          const reason = `integration branch reconcile failed: ${String(err)}`;
          this.operations.fail({ repoDir: this.workingDir, epicRef: epic.ref, reason });
          this.onError(`epic ${epic.ref} ${reason}`);
        }
      }

      if (this.epicIntegrate) {
        const members = await Promise.all(
          epic.members.map(async (ref) => {
            const task = byRef.get(ref);
            return reduceMemberState(task ? await this.tasks.get(task.id) : undefined);
          }),
        );
        void this.epicIntegrate
          .submit({ ref: epic.ref, members, memberRefs: epic.members })
          .catch((err) => this.onError(`epic ${epic.ref} whole-Epic integrate attempt failed: ${String(err)}`));
      }
    }
  }

  /**
   * The member refs of a derived leaf Epic from the most recent scan; `[]` when
   * the Epic isn't in the last scan (never reconciled, or gone).
   */
  membersOf(epicRef: number): number[] {
    return deriveLeafEpics(this.latestTickets).find((epic) => epic.ref === epicRef)?.members ?? [];
  }

  /**
   * Whether `task` is a ready Epic member still awaiting its integration branch
   * base. An ordinary ready Task (no Epic) is never gated.
   */
  awaitsBase(task: TaskRow): boolean {
    return (
      task.origin === 'mirrored' &&
      task.baseBranch == null &&
      task.trackerRef != null &&
      this.readyMemberRefs.has(task.trackerRef)
    );
  }

  /**
   * Whether a member is not yet safe to spawn a worktree Attempt for: its base is
   * still unresolved ({@link awaitsBase}), or its base is an `epic/<ref>`
   * integration branch that does not currently exist in git. A non-mirrored
   * Task, or a member on an ordinary (non-Epic) branch, is never gated. On a
   * git error the member is gated (fail closed).
   */
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

  /**
   * Retire an Epic's integration branch once its Epic has fully integrated.
   * Idempotent: a no-op when the branch is already gone.
   */
  async retireIntegrationBranch(epicRef: number): Promise<void> {
    const branch = integrationBranchName(epicRef);
    const defaultBranch = await this.git.symbolicBranch(this.workingDir);
    if (defaultBranch === null) return;
    if (!(await this.git.branchExists(this.workingDir, branch))) return;
    if ((await this.git.branchCheckedOutAt(this.workingDir, branch)) !== null) return;
    if (!(await this.git.isAncestor(this.workingDir, defaultBranch, branch))) return;
    await this.git.deleteBranch(this.workingDir, branch);
  }
}
