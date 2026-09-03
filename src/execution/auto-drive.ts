import { type AppConfig, type MergeFate } from '../config.js';
import type { TaskRow, AttemptRow, WorkspaceRow, StoredEpicKind } from '../db/schema.js';
import { resolveTrackerAdapter, type TrackerAdapter } from '../tracker/adapter.js';
import { resolveDrive, type ResolvedDrive } from '../domain/setting-override.js';
import { driveFields, fillTemplate, splitTitleBody } from './prompt-template.js';

type DriveWorkspace = Pick<
  WorkspaceRow,
  'drivePrompt' | 'driveUnattendedReminder' | 'driveContinuePrompt' | 'driveMergeFate' | 'driveContinueAttempts'
>;

/**
 * The auto-drive half of afk mirrored-Task execution: the Drive Prompt the
 * Runner injects, and what becomes of a clean completion (Merge Fate +
 * fallback-close). Absent on a native-only server.
 */
export class AutoDrive {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly urlFor: (task: TaskRow) => string | null,
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    /** Resolves a Task's Workspace so `drive.*` inherits its per-Workspace
     * overrides; absent → every field resolves the global default. */
    private readonly getWorkspace?: (workspaceId: number | null) => Promise<DriveWorkspace | undefined>,
    /** Resolves the stored `kind` of a Task's parent Epic (its `mapRef`); a Map
     * child drives `/wayfinder {mapRef}`. Absent → every child keeps its own drive. */
    private readonly getEpicKind?: (workspaceId: number, ref: number) => Promise<StoredEpicKind | null>,
    /** Notified when {@link closeTicket} issues a genuine tracker close (a real
     * ref that was open) — the hook that records the Timeline's ticket-closed
     * event. Not fired for the no-op paths (no ref, or already closed). */
    private readonly onTicketClosed?: (task: TaskRow) => void,
  ) {}

  /** The auto-driven path: a mirrored Task Harmonic runs unattended. */
  handles(task: TaskRow): boolean {
    return task.origin === 'mirrored';
  }

  private async resolvedDrive(task: TaskRow): Promise<ResolvedDrive> {
    const ws = await this.getWorkspace?.(task.workspaceId);
    return resolveDrive(ws, this.getConfig());
  }

  private async epicKindFor(task: TaskRow): Promise<StoredEpicKind | null> {
    if (task.mapRef == null || task.workspaceId == null || !this.getEpicKind) return null;
    return this.getEpicKind(task.workspaceId, task.mapRef);
  }

  /** The Drive Prompt for a mirrored Task — the resolved template filled from it. */
  async prompt(task: TaskRow): Promise<string> {
    const drive = await this.resolvedDrive(task);
    const epicKind = await this.epicKindFor(task);
    const filled = fillTemplate(drive.prompt, driveFields({ ...task, epicKind }, this.urlFor));
    const feedback = task.feedback?.trim();
    const withFeedback = feedback ? `${filled}\n\n## Feedback from the previous attempt\n\n${feedback}` : filled;
    return `${withFeedback}\n\n${this.reminderFrom(drive, task)}`;
  }

  private reminderFrom(drive: ResolvedDrive, task: TaskRow): string {
    return drive.unattendedReminder.replace(/\{taskId\}/g, String(task.id));
  }

  /**
   * Re-prompt for an Attempt that ended its turn without finishing or escalating.
   * Nudges the agent to resume rather than idle-wait, and re-states the
   * unattended reminder (working memory is short across turns).
   */
  async continuePrompt(task: TaskRow): Promise<string> {
    const drive = await this.resolvedDrive(task);
    const nudge = drive.continuePrompt.replace(/\{taskId\}/g, String(task.id));
    return `${nudge}\n\n${this.reminderFrom(drive, task)}`;
  }

  /** How many times to re-prompt an unfinished Attempt before treating it as unresolved. */
  async continueAttempts(task: TaskRow): Promise<number> {
    return (await this.resolvedDrive(task)).continueAttempts;
  }

  private async mergeFate(task: TaskRow): Promise<MergeFate> {
    return task.wayfinderType === 'research' ? 'artifact' : (await this.resolvedDrive(task)).mergeFate;
  }

  /** The Merge Fate for a Task — the same fate {@link onCompleted} applies. */
  async mergeFateFor(task: TaskRow): Promise<MergeFate> {
    return this.mergeFate(task);
  }

  /**
   * Merge a passing afk Attempt's work per its Merge Fate. Harmonic owns the close,
   * only after verify + merge:
   *
   * - **auto-merge** — the Runner has already merged the verified branch, so
   *   Harmonic closes the ticket. A close that fails Escalates.
   * - **open-PR** — open a PR and leave the ticket **open**; the PR's own merge
   *   closes the issue later. A PR that can't be created Escalates. A tracker
   *   with no PR support degrades to artifact.
   * - **artifact** (incl. research) — leave the branch and the ticket untouched.
   *
   * Returns `'completed'` once the fate has merged, or `'escalate'` when it
   * could not be applied.
   */
  async onCompleted(task: TaskRow, run: AttemptRow): Promise<'completed' | 'escalate'> {
    const worktree = task.isolationMode === 'worktree';
    const fate = await this.mergeFate(task);

    if (fate === 'open-PR') {
      if (worktree) {
        const adapter = await this.resolveAdapter(task.workingDir);
        if (adapter.openPR) {
          const { title } = splitTitleBody(task.prompt);
          try {
            await adapter.openPR({
              branch: run.branch!,
              baseBranch: run.baseBranch!,
              title,
              body: `Auto-driven by Harmonic for #${task.trackerRef}.`,
            });
          } catch {
            return 'escalate';
          }
          return 'completed';
        }
      }
      return 'completed';
    }

    if (fate === 'auto-merge') {
      return (await this.closeTicket(task)) ? 'completed' : 'escalate';
    }

    return 'completed';
  }

  /**
   * The auto-merge close step, for a path that already merged the branch
   * elsewhere. Returns whether the close was issued (false ⇒ the caller Escalates).
   */
  async closeCompleted(task: TaskRow): Promise<boolean> {
    return this.closeTicket(task);
  }

  /**
   * Close the Task's ticket. Returns whether the close was issued; a read/write
   * failure returns false so the caller can record the infrastructure failure.
   * No tracker ref means nothing to close.
   */
  async closeTicket(task: TaskRow, comment = `Completed and merged by Harmonic (task ${task.id}).`): Promise<boolean> {
    if (task.trackerRef == null) return true;
    try {
      const adapter = await this.resolveAdapter(task.workingDir);
      if (!adapter.close) return true;
      const { title } = splitTitleBody(task.prompt);
      const ref = { number: task.trackerRef, title, state: 'open' as const };
      // Closing an already-closed issue errors on some trackers (`gh issue close`).
      if ((await adapter.readTicket(ref)).state === 'closed') return true;
      await adapter.close(ref, comment);
      this.onTicketClosed?.(task);
      return true;
    } catch {
      return false;
    }
  }
}
