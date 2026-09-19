import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from './git.js';
import { GitError } from '../domain/errors.js';
import { attempted, bestEffort } from '../error-handling.js';
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
import type { RunnerEvents, Workspace } from './runner-options.js';

export interface WorkspaceProvisionerDeps {
  attempts: AttemptStore;
  sessionStore: SessionStore;
  mergeCoordinator: MergeCoordinator;
  autoDrive: AutoDrive | undefined;
  sessionRetirement: SessionRetirementHook | undefined;
  events: RunnerEvents;
  worktreesDir: string;
}

export class WorkspaceProvisioner {
  constructor(private readonly deps: WorkspaceProvisionerDeps) {}

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
        await Git.removeWorktree(session.worktreeRepoDir, removedPath)
          .then(() => dropIndexForPath(removedPath))
          .catch((err) => logger.error(`task ${task.id} close: worktree removal failed: ${String(err)}`));
      }
      if (run.branch && (await Git.branchCheckedOutAt(task.workingDir, run.branch).catch(() => null)) === null) {
        await Git.deleteBranch(task.workingDir, run.branch).catch((err) =>
          logger.error(`task ${task.id} close: branch '${run.branch}' removal failed: ${String(err)}`),
        );
      }
      this.deps.events.onAttemptFinished?.(await this.deps.attempts.get(run.id));
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
    mkdirSync(this.deps.worktreesDir, { recursive: true });

    if (existsSync(path) && !(await Git.isValidWorktree(task.workingDir, path))) {
      await Git.discardOrphanWorktree(task.workingDir, path);
    }

    if (resume) {
      const persisted = await this.deps.attempts.get(run.id);
      const branch = persisted.branch ?? this.branchForTask(task);
      const baseBranch = persisted.baseBranch ?? (await this.deps.mergeCoordinator.resolveBaseBranch(task));
      if (!existsSync(path)) {
        await Git.addWorktreeCheckout(task.workingDir, path, branch);
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
      await Git.addWorktreeCheckout(task.workingDir, path, branch);
      await this.deps.attempts.update(run.id, { branch, baseBranch });
      return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
    }
    if (parseIntegrationBranch(baseBranch) !== null && !(await Git.branchExists(task.workingDir, baseBranch))) {
      throw new EpicBaseNotReady(
        `Epic integration branch ${baseBranch} does not exist yet; it is cut/re-cut on the next tracker poll`,
      );
    }
    await Git.addWorktree(task.workingDir, path, branch, baseBranch);
    await this.deps.attempts.update(run.id, { branch, baseBranch });
    return { cwd: path, env: {}, worktree: { repoDir: task.workingDir, path }, baseRev: baseBranch, startDirty: false };
  }

  async finalizeWorkspace(task: TaskRow, run: AttemptRow, attemptNumber: number, workspace: Workspace): Promise<void> {
    if (!workspace.worktree) return;
    const { repoDir, path } = workspace.worktree;
    await bestEffort(() => Git.commitAll(path, `harmonic: task ${task.id} attempt ${attemptNumber}`), {
      op: 'runner.finalizeWorkspace.commitAll',
      level: 'error',
      context: { taskId: task.id, attemptId: run.id, attemptNumber, path },
    });
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
    if (!retained) {
      await bestEffort(() => Git.removeWorktree(repoDir, path), {
        op: 'runner.finalizeWorkspace.removeWorktree',
        level: 'debug',
        context: { taskId: task.id, attemptId: run.id, attemptNumber, repoDir, worktreePath: path },
      });
    }
  }
}
