import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Git } from './git.js';
import { GitError } from '../domain/errors.js';
import { attempted, bestEffort, errorMessage } from '../error-handling.js';
import { adapterFor } from './harness/registry.js';
import { dropIndexForPath } from './code-index.js';
import { parseIntegrationBranch } from './epic-coordinator.js';
import { EpicBaseNotReady, type MergeCoordinator } from './merge-coordinator.js';
import type { AutoDrive } from './auto-drive.js';
import type { HarnessConfig } from '../config.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import type { SessionStore } from '../domain/sessions.js';
import type { AttemptStore } from '../domain/attempts.js';
import type { SessionRetirementHook } from '../domain/session-retirement-coordinator.js';
import { logger } from '../logger.js';
import type { RunnerEvents, TaskEventAppender, Workspace } from './runner-options.js';

export interface WorkspaceProvisionerDeps {
  attempts: AttemptStore;
  sessionStore: SessionStore;
  mergeCoordinator: MergeCoordinator;
  autoDrive: AutoDrive | undefined;
  sessionRetirement: SessionRetirementHook | undefined;
  events: RunnerEvents;
  worktreesDir: string;
  /** Absent → a Close with no Attempt drops its cleanup row. */
  taskEvents?: TaskEventAppender;
}

export class WorkspaceProvisioner {
  constructor(private readonly deps: WorkspaceProvisionerDeps) {}

  private async record(run: Pick<AttemptRow, 'id'>, payload: Record<string, unknown>): Promise<void> {
    try {
      const event = await this.deps.attempts.appendEvent(run.id, { type: 'lifecycle', payload });
      this.deps.events.onAttemptEvent?.(event);
    } catch (err) {
      logger.error(`attempt ${run.id}: ${String(payload.event)} event append failed: ${String(err)}`);
    }
  }

  private async recordTask(task: Pick<TaskRow, 'id'>, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.taskEvents?.appendEvent(task.id, payload);
      this.deps.events.onTaskEvent?.(task.id);
    } catch (err) {
      logger.error(`task ${task.id}: ${String(payload.event)} event append failed: ${String(err)}`);
    }
  }

  /**
   * Close: the ticket is cancelled; remove its branch and worktree and close
   * the tracker issue. Every step is a best-effort output side-effect.
   */
  async cleanupClosed(task: TaskRow, run: AttemptRow | undefined): Promise<void> {
    if (run) {
      try {
        await this.deps.sessionRetirement?.onAttemptSettled(run, 'operator-cancel');
      } catch (err) {
        logger.error(`task ${task.id} close: session retirement failed: ${String(err)}`);
      }
      // git refuses to delete a branch a worktree still checks out.
      const session = run.sessionRowId === null ? null : await this.deps.sessionStore.get(run.sessionRowId).catch(() => null);
      if (session?.worktreePath && session.worktreeRepoDir && existsSync(session.worktreePath)) {
        const removedPath = session.worktreePath;
        const worktree = basename(removedPath);
        try {
          await Git.removeWorktree(session.worktreeRepoDir, removedPath);
          await dropIndexForPath(removedPath);
          await this.record(run, { event: 'worktree-removed', worktree });
        } catch (err) {
          logger.error(`task ${task.id} close: worktree removal failed: ${String(err)}`);
          await this.record(run, { event: 'worktree-remove-failed', worktree, error: errorMessage(err) });
        }
      }
      if (run.branch && (await Git.branchCheckedOutAt(task.workingDir, run.branch).catch(() => null)) === null) {
        try {
          await Git.deleteBranch(task.workingDir, run.branch);
          await this.record(run, { event: 'branch-deleted', branch: run.branch });
        } catch (err) {
          logger.error(`task ${task.id} close: branch '${run.branch}' removal failed: ${String(err)}`);
          await this.record(run, { event: 'branch-delete-failed', branch: run.branch, error: errorMessage(err) });
        }
      }
      this.deps.events.onAttemptFinished?.(await this.deps.attempts.get(run.id));
    } else {
      const worktreePath = this.worktreePathForTask(task);
      if (existsSync(worktreePath)) {
        const worktree = basename(worktreePath);
        try {
          await Git.removeWorktree(task.workingDir, worktreePath);
          await dropIndexForPath(worktreePath);
          await this.recordTask(task, { event: 'worktree-removed', worktree });
        } catch (err) {
          logger.error(`task ${task.id} close: worktree removal failed: ${String(err)}`);
          await this.recordTask(task, { event: 'worktree-remove-failed', worktree, error: errorMessage(err) });
        }
      }
      const branch = this.branchForTask(task);
      if (
        (await Git.branchExists(task.workingDir, branch).catch(() => false)) &&
        (await Git.branchCheckedOutAt(task.workingDir, branch).catch(() => null)) === null
      ) {
        try {
          await Git.deleteBranch(task.workingDir, branch);
          await this.recordTask(task, { event: 'branch-deleted', branch });
        } catch (err) {
          logger.error(`task ${task.id} close: branch '${branch}' removal failed: ${String(err)}`);
          await this.recordTask(task, { event: 'branch-delete-failed', branch, error: errorMessage(err) });
        }
      }
    }
    if (this.deps.autoDrive && !(await this.deps.autoDrive.closeTicket(task, `Closed by a Harmonic operator without merging (task ${task.id}).`))) {
      logger.error(`task ${task.id} close: tracker issue could not be closed`);
    }
  }

  worktreePathForTask(task: TaskRow): string {
    return join(this.deps.worktreesDir, `task-${task.id}`);
  }

  dispatchCwd(task: TaskRow): string {
    return task.isolationMode === 'worktree' ? this.worktreePathForTask(task) : task.workingDir;
  }

  branchForTask(task: TaskRow): string {
    return `harmonic/task-${task.id}`;
  }

  spawnHarness(
    task: TaskRow,
    harness: HarnessConfig,
    cwd: string,
    extraEnv: Record<string, string>,
    unattended: boolean,
  ): ChildProcess {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...harness.env,
      HARMONIC_MODEL: task.model,
      ...adapterFor(task.harness).spawnEnv({ model: task.model, cwd, sessionLogDir: harness.sessionLogDir, unattended }),
      ...extraEnv,
    };
    return spawn(harness.command, harness.args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  }

  async prepareWorkspace(task: TaskRow, run: AttemptRow, resume = false): Promise<Workspace> {
    if (task.isolationMode !== 'worktree') {
      const workspace: Workspace = { cwd: task.workingDir, env: {} };
      const resolved = await attempted(
        async () => ({
          baseRev: await Git.revParse(task.workingDir, 'HEAD'),
          startDirty: resume ? false : await Git.isDirty(task.workingDir),
        }),
        {
          op: 'runner.prepareWorkspace.baseRev',
          level: 'warn',
          notFoundIf: (err) =>
            err instanceof GitError && /unknown revision|ambiguous argument 'HEAD'|does not have any commits yet/i.test(err.stderr),
          context: { taskId: task.id, attemptId: run.id, workingDir: task.workingDir, resume },
        },
      );
      if (resolved.ok) {
        workspace.baseRev = resolved.value.baseRev;
        workspace.startDirty = resolved.value.startDirty;
      }
      return workspace;
    }

    const path = this.worktreePathForTask(task);
    const worktree = basename(path);
    mkdirSync(this.deps.worktreesDir, { recursive: true });

    if (existsSync(path) && !(await Git.isValidWorktree(task.workingDir, path))) {
      await Git.discardOrphanWorktree(task.workingDir, path);
      await this.record(run, { event: 'worktree-discarded', worktree });
    }

    // A killed prior attempt skips finalizeWorkspace's commitAll, so a reused
    // worktree can still be dirty here; the rebase step below refuses to run
    // on a dirty tree, so snapshot any leftovers first (no-op if clean).
    if (existsSync(path)) {
      const recovered = await attempted(() => Git.commitAll(path, `harmonic: task ${task.id} recovered leftover work`), {
        op: 'runner.prepareWorkspace.commitAll',
        level: 'error',
        context: { taskId: task.id, attemptId: run.id, path },
      });
      if (recovered.ok && recovered.value !== null) {
        await this.record(run, { event: 'work-committed', oid: recovered.value, reason: 'recovered' });
      }
    }

    if (resume) {
      const persisted = await this.deps.attempts.get(run.id);
      const branch = persisted.branch ?? this.branchForTask(task);
      const baseBranch = persisted.baseBranch ?? (await this.deps.mergeCoordinator.resolveBaseBranch(task));
      if (!existsSync(path)) {
        try {
          await Git.addWorktreeCheckout(task.workingDir, path, branch);
        } catch (err) {
          await this.record(run, { event: 'worktree-create-failed', worktree, branch, baseBranch, error: errorMessage(err) });
          throw err;
        }
        await this.record(run, { event: 'worktree-created', worktree, branch, baseBranch: null, fromExistingBranch: true });
      }
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }

    const baseBranch = await this.deps.mergeCoordinator.resolveBaseBranch(task);
    const branch = this.branchForTask(task);
    if (existsSync(path)) {
      await this.deps.attempts.update(run.id, { branch, baseBranch });
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }
    if (await Git.branchExists(task.workingDir, branch)) {
      try {
        await Git.addWorktreeCheckout(task.workingDir, path, branch);
      } catch (err) {
        await this.record(run, { event: 'worktree-create-failed', worktree, branch, baseBranch, error: errorMessage(err) });
        throw err;
      }
      await this.deps.attempts.update(run.id, { branch, baseBranch });
      await this.record(run, { event: 'worktree-created', worktree, branch, baseBranch: null, fromExistingBranch: true });
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }
    if (parseIntegrationBranch(baseBranch) !== null && !(await Git.branchExists(task.workingDir, baseBranch))) {
      throw new EpicBaseNotReady(
        `Epic integration branch ${baseBranch} does not exist yet; it is cut/re-cut on the next tracker poll`,
      );
    }
    try {
      await Git.addWorktree(task.workingDir, path, branch, baseBranch);
    } catch (err) {
      await this.record(run, { event: 'worktree-create-failed', worktree, branch, baseBranch, error: errorMessage(err) });
      throw err;
    }
    await this.deps.attempts.update(run.id, { branch, baseBranch });
    await this.record(run, { event: 'worktree-created', worktree, branch, baseBranch, fromExistingBranch: false });
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
  }

  async finalizeWorkspace(task: TaskRow, run: AttemptRow, attemptNumber: number, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    const { repoDir, path } = workspace.worktree;
    const worktree = basename(path);
    const committed = await attempted(() => Git.commitAll(path, `harmonic: task ${task.id} attempt ${attemptNumber}`), {
      op: 'runner.finalizeWorkspace.commitAll',
      level: 'error',
      context: { taskId: task.id, attemptId: run.id, attemptNumber, path },
    });
    if (committed.ok) {
      if (committed.value !== null) await this.record(run, { event: 'work-committed', oid: committed.value, reason: 'attempt-end', attempt: attemptNumber });
    } else {
      await this.record(run, { event: 'commit-failed', error: committed.message });
    }
    const sessionRowId = (await this.deps.attempts.get(run.id)).sessionRowId;
    let retained = false;
    if (sessionRowId != null) {
      retained = await bestEffort(() => this.deps.sessionStore.bindWorktree(sessionRowId, repoDir, path, Date.now()), {
        op: 'runner.finalizeWorkspace.bindWorktree',
        level: 'error',
        notFoundLevel: 'info',
        context: { taskId: task.id, attemptId: run.id, attemptNumber, sessionRowId, repoDir, worktreePath: path },
      });
    }
    if (retained) {
      await this.record(run, { event: 'worktree-retained', worktree });
      return;
    }
    try {
      await Git.removeWorktree(repoDir, path);
      await this.record(run, { event: 'worktree-removed', worktree });
    } catch (err) {
      await this.record(run, { event: 'worktree-remove-failed', worktree, error: errorMessage(err) });
    }
  }
}
