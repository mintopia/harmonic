import type { TrackerRef } from '../tracker/adapter.js';
import type { TaskRow, AttemptRow, WorkspaceRow, StoredEpicKind } from '../db/schema.js';
import { formatWorkspaceTrackerRef, resolveTrackerAdapter, workspaceTrackerSettings, type TrackerAdapter, type TicketRef, type WorkspaceTrackerSettings } from '../tracker/adapter.js';
import type { FeatureIndex } from '../tracker/local-markdown.js';
import { resolveRepositoryWithoutSecrets, type RepositoryResolver } from '../repository/resolve.js';
import { driveFields, splitTitleBody, type DriveFields } from './prompt-template.js';
import { Git } from './git.js';
import { withBaseCheckoutLock } from './repo-lock.js';
import { logger } from '../logger.js';
import { errorMessage } from '../error-handling.js';

type DriveWorkspace = Partial<Pick<WorkspaceRow, 'configuredTracker' | 'codeRepository'>>;

const completionComment = (task: TaskRow): string => `Completed and merged by Harmonic (task ${task.id}).`;

/** The tracker side of a mirrored Task's workflow: prompt fields, opening a PR, closing and commenting on the ticket. Absent on a native-only server. */
export class AutoDrive {
  constructor(
    private readonly urlFor: (task: TaskRow) => string | null,
    private readonly resolveAdapter: (repoRoot: string, featureIndex?: FeatureIndex, workspace?: WorkspaceTrackerSettings) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly getWorkspace?: (workspaceId: number | null) => Promise<DriveWorkspace | undefined>,
    /** Resolves the stored `kind` of a Task's parent Epic (its `mapRef`); a Map
     * child drives `/wayfinder {mapRef}`. Absent → every child keeps its own drive. */
    private readonly getEpicKind?: (workspaceId: number, ref: TrackerRef) => Promise<StoredEpicKind | null>,
    /** Notified on a genuine tracker close (not the no-op paths). `commit` is
     * the base-checkout commit for a file-backed tracker, else `null`. */
    private readonly onTicketClosed?: (task: TaskRow, commit: { oid: string; paths: string[] } | null) => void,
    /** Notified when a close attempt throws. */
    private readonly onTicketCloseFailed?: (task: TaskRow, error: unknown) => void,
    private readonly resolveRepository: RepositoryResolver = resolveRepositoryWithoutSecrets,
    /** Persists the PR/MR URL the open-PR fate created onto the Attempt that opened it. */
    private readonly recordPullRequest?: (run: AttemptRow, url: string) => Promise<void>,
  ) {}

  /** The auto-driven path: a mirrored Task Harmonic runs unattended. */
  handles(task: TaskRow): boolean {
    return task.origin === 'mirrored';
  }

  private async epicKindFor(task: TaskRow): Promise<StoredEpicKind | null> {
    if (task.mapRef == null || task.workspaceId == null || !this.getEpicKind) return null;
    return this.getEpicKind(task.workspaceId, task.mapRef);
  }

  async promptFields(task: TaskRow): Promise<DriveFields> {
    return driveFields({ ...task, epicKind: await this.epicKindFor(task) }, this.urlFor);
  }

  /** Opens a PR for the Attempt's branch and records its URL; null when the repo has no Code Repository adapter or the kind opens none. Throws when the forge call fails. */
  async openPullRequest(task: TaskRow, run: AttemptRow): Promise<string | null> {
    const workspace = workspaceTrackerSettings(await this.getWorkspace?.(task.workspaceId));
    const repository = await this.resolveRepository(task.workingDir, workspace);
    if (!repository) return null;
    const { title } = splitTitleBody(task.prompt);
    const pullRequestUrl = await repository.openPR({
      branch: run.branch!,
      baseBranch: run.baseBranch!,
      title,
      body: `Auto-driven by Harmonic for ${task.trackerRef == null ? `Task ${task.id}` : await formatWorkspaceTrackerRef(task.workingDir, workspace, task.trackerRef)}.`,
    });
    if (pullRequestUrl !== null) {
      await this.recordPullRequest?.(run, pullRequestUrl).catch((err: unknown) => {
        logger.warn(`[auto-drive] PR opened for task ${task.id} but its URL was not recorded: ${errorMessage(err)}`);
      });
    }
    return pullRequestUrl;
  }

  /**
   * Close the Task's ticket. Returns whether the close was issued; a read/write
   * failure returns false so the caller can record the infrastructure failure.
   * No tracker ref means nothing to close.
   */
  async closeTicket(task: TaskRow, comment = completionComment(task)): Promise<boolean> {
    const result = await this.attemptClose(task, comment);
    if (!result.ok) this.onTicketCloseFailed?.(task, result.error);
    return result.ok;
  }

  /** Posts a comment on the Task's ticket. Returns false when there is no ticket or the tracker cannot comment; throws when the tracker call fails. */
  async commentOnTicket(task: TaskRow, body: string): Promise<boolean> {
    if (task.trackerRef == null) return false;
    const adapter = await this.resolveAdapter(task.workingDir, undefined, workspaceTrackerSettings(await this.getWorkspace?.(task.workspaceId)));
    if (!adapter.comment) return false;
    const { title } = splitTitleBody(task.prompt);
    const ref = { ref: task.trackerRef, title, state: 'open' as const };
    if (adapter.persistsInWorkingTree) {
      await this.commitLifecycleWrite(task, ref, () => adapter.comment!(ref, body), body);
    } else {
      await adapter.comment(ref, body);
    }
    return true;
  }

  retryTicketClose(task: TaskRow): Promise<{ ok: true } | { ok: false; error: unknown }> {
    return this.attemptClose(task, completionComment(task));
  }

  private async attemptClose(task: TaskRow, comment: string): Promise<{ ok: true } | { ok: false; error: unknown }> {
    if (task.trackerRef == null) return { ok: true };
    try {
      const adapter = await this.resolveAdapter(task.workingDir, undefined, workspaceTrackerSettings(await this.getWorkspace?.(task.workspaceId)));
      if (!adapter.close) return { ok: true };
      const { title } = splitTitleBody(task.prompt);
      const ref = { ref: task.trackerRef, title, state: 'open' as const };
      // Closing an already-closed issue errors on some trackers (`gh issue close`).
      const current = adapter.readState ? await adapter.readState(ref) : (await adapter.readTicket(ref)).state;
      if (current === 'closed') return { ok: true };
      let commit: { oid: string; paths: string[] } | null = null;
      if (adapter.persistsInWorkingTree) {
        commit = await this.commitLifecycleWrite(task, ref, () => adapter.close!(ref, comment), comment);
      } else {
        await adapter.close(ref, comment);
      }
      this.onTicketClosed?.(task, commit);
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * A file-backed tracker's lifecycle write mutates a ticket file in the base
   * checkout; commit it onto the base branch under the base-checkout lock (the
   * same mutex the merge holds), so it never lingers as a dirty working-tree
   * change that breaks the next merge. The write runs inside the lock so it can
   * never race a concurrent merge. See ADR-0004.
   */
  private async commitLifecycleWrite(
    task: TaskRow,
    ref: TicketRef,
    write: () => Promise<{ changedPaths?: string[] } | void>,
    message: string,
  ): Promise<{ oid: string; paths: string[] } | null> {
    return withBaseCheckoutLock(task.workingDir, async () => {
      const result = await write();
      const paths = result?.changedPaths ?? [];
      if (paths.length === 0) return null;
      const oid = await Git.commitPaths(task.workingDir, paths, message);
      if (oid === null) return null;
      logger.info('tracker: committed lifecycle change to base', {
        'tracker.ref': ref.ref,
        'tracker.paths': paths.length,
        'repo.dir': task.workingDir,
      });
      return { oid, paths };
    });
  }
}
