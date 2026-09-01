import { type AppConfig, type MergeFate } from '../config.js';
import type { TaskRow, AttemptRow, WorkspaceRow, StoredEpicKind } from '../db/schema.js';
import { resolveTrackerAdapter, type TrackerAdapter } from '../tracker/adapter.js';
import { resolveDrive, type ResolvedDrive } from '../domain/setting-override.js';
import { driveFields, fillTemplate, splitTitleBody } from './prompt-template.js';

/** The Workspace columns auto-drive resolution reads (ADR-0044). A full
 * `WorkspaceRow` satisfies it, so the app can pass its shared resolver. */
type DriveWorkspace = Pick<
  WorkspaceRow,
  'drivePrompt' | 'driveUnattendedReminder' | 'driveContinuePrompt' | 'driveMergeFate' | 'driveContinueAttempts'
>;

/**
 * The auto-drive half of afk mirrored-Task execution (issue #33): the Drive
 * Prompt the Runner injects, and the runtime decision it delegates — what
 * becomes of a clean completion (Merge Fate + fallback-close). The Runner owns
 * Task/Run state transitions and failure routing (the unified Attempt loop,
 * ADR-0041); this class only decides and performs the tracker/git side
 * effects. Absent on a native-only server, where every Run settles the plain
 * way.
 */
export class AutoDrive {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly urlFor: (task: TaskRow) => string | null,
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    /** Resolves a Task's Workspace so `drive.*` inherits its per-Workspace
     * overrides (ADR-0044); absent → every field resolves the global default. */
    private readonly getWorkspace?: (workspaceId: number | null) => Promise<DriveWorkspace | undefined>,
    /** Resolves the stored `kind` of a Task's parent Epic (its `mapRef`) from the
     * Epic spine (ADR-0018, #437); a Map child drives `/wayfinder {mapRef}`
     * (issue #440). Absent → every child keeps its own research/implement drive. */
    private readonly getEpicKind?: (workspaceId: number, ref: number) => Promise<StoredEpicKind | null>,
  ) {}

  /** The auto-driven path: a mirrored Task Harmonic runs unattended. */
  handles(task: TaskRow): boolean {
    return task.origin === 'mirrored';
  }

  /** This Task's effective auto-drive config: each `drive.*` field resolved
   * `workspace ?? global` (ADR-0044). One Workspace read per call. */
  private async resolvedDrive(task: TaskRow): Promise<ResolvedDrive> {
    const ws = await this.getWorkspace?.(task.workspaceId);
    return resolveDrive(ws, this.getConfig());
  }

  /** The stored `kind` of a Task's parent Epic, or null when it has no mapRef or
   * no resolver is wired. A Map child drives the wayfinder skill (issue #440). */
  private async epicKindFor(task: TaskRow): Promise<StoredEpicKind | null> {
    if (task.mapRef == null || task.workspaceId == null || !this.getEpicKind) return null;
    return this.getEpicKind(task.workspaceId, task.mapRef);
  }

  /** The Drive Prompt for a mirrored Task — the resolved template filled from it. */
  async prompt(task: TaskRow): Promise<string> {
    const drive = await this.resolvedDrive(task);
    const epicKind = await this.epicKindFor(task);
    const filled = fillTemplate(drive.prompt, driveFields({ ...task, epicKind }, this.urlFor));
    // A re-queued mirrored Task carries operator feedback in its column (the
    // prompt is re-derived from the ticket each poll). Append it so the retry
    // sees it — same section the native review/re-attempt path uses (run-prompt.ts).
    const feedback = task.feedback?.trim();
    const withFeedback = feedback ? `${filled}\n\n## Feedback from the previous attempt\n\n${feedback}` : filled;
    return `${withFeedback}\n\n${this.reminderFrom(drive, task)}`;
  }

  /** The operator-editable unattended reminder with this Task's id filled in (initial + continue). */
  private reminderFrom(drive: ResolvedDrive, task: TaskRow): string {
    return drive.unattendedReminder.replace(/\{taskId\}/g, String(task.id));
  }

  /**
   * Re-prompt for a Run that ended its turn without finishing or escalating.
   * Nudges the agent to resume rather than idle-wait, and re-states the
   * unattended reminder (working memory is short across turns).
   */
  async continuePrompt(task: TaskRow): Promise<string> {
    const drive = await this.resolvedDrive(task);
    const nudge = drive.continuePrompt.replace(/\{taskId\}/g, String(task.id));
    return `${nudge}\n\n${this.reminderFrom(drive, task)}`;
  }

  /** How many times to re-prompt an unfinished Run before treating it as unresolved. */
  async continueAttempts(task: TaskRow): Promise<number> {
    return (await this.resolvedDrive(task)).continueAttempts;
  }

  /** research is always an artifact; otherwise the resolved (Workspace ?? global) fate. */
  private async mergeFate(task: TaskRow): Promise<MergeFate> {
    return task.wayfinderType === 'research' ? 'artifact' : (await this.resolvedDrive(task)).mergeFate;
  }

  /**
   * The Merge Fate for a Task, exposed so the Runner can gate deterministic
   * recovery merging (issue #154) on the **same** fate this class applies — a
   * direct-mode Run only merges its reconstructed candidate onto the intended
   * branch when the fate is `auto-merge`; `open-PR`/`artifact` leave the branch
   * untouched (the work stays on the candidate/private ref). Single source of
   * truth so recovery merging never diverges from `onCompleted`'s fate.
   */
  async mergeFateFor(task: TaskRow): Promise<MergeFate> {
    return this.mergeFate(task);
  }

  /**
   * Merge a passing afk Run's work per its Merge Fate — the close-after-verify
   * model (issue #139, ADR-0021, reliability-design Unit B). The
   * execution-complete signal is the agent's `finish_task` (the Runner's
   * `agentFinished` gate), **not** the agent closing the ticket: under this
   * model Harmonic itself owns the close, and only after verify + merge. So this
   * never gates on the ticket state — it closes where the fate says:
   *
   * - **auto-merge** — the Runner has already merged the verified branch via the
   *   one merge policy (ADR-0001; an Epic member merges onto its `epic/<ref>`
   *   integration branch the same way), so Harmonic closes the ticket. A close
   *   that fails Escalates (a human finishes the close, the work is safe).
   * - **open-PR** — open a PR and leave the ticket **open**: creating a PR is not
   *   merging, so the PR's own merge closes the issue later. A PR that can't be
   *   created Escalates. A tracker with no PR support degrades to artifact.
   * - **artifact** (incl. research) — leave the branch and the ticket untouched;
   *   no merge, no close.
   *
   * Returns `'completed'` once the fate has merged, or `'escalate'` when it
   * could not be applied. Unlike the pre-#139 model there is no `'unresolved'`
   * outcome here — a Run with no `finish_task` signal never reaches this method
   * (the Runner routes it to the failure path before verification).
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
            return 'escalate'; // PR creation failed — don't strand the work
          }
          return 'completed'; // the PR is the review surface; the issue stays open
        }
      }
      // Direct mode, or a tracker with no PR concept: degrade to artifact —
      // leave the branch and the ticket as they are.
      return 'completed';
    }

    if (fate === 'auto-merge') {
      // The Runner has already merged the verified tip (SHA-asserted, ADR-0041);
      // Harmonic owns the close (issue #139).
      return (await this.closeTicket(task)) ? 'completed' : 'escalate';
    }

    // artifact (incl. research): leave the branch and the ticket untouched.
    return 'completed';
  }

  /**
   * The auto-merge close step, split out from {@link onCompleted} so a path that
   * already merged the branch elsewhere — operator Accept's journaled merge
   * effect and crash-recovery replay — reuses the close-after-merge half without
   * re-running the merge. Harmonic owns the close (#139), only after a successful
   * merge. Returns whether the close was issued (false ⇒ the caller Escalates).
   */
  async closeCompleted(task: TaskRow): Promise<boolean> {
    return this.closeTicket(task);
  }

  /**
   * Close the Task's ticket — the final merging step (issue #139; Harmonic, not
   * the agent, owns the close), or an operator Close. A pure output side-effect
   * (ADR-0041): returns whether the close was issued; a read/write failure
   * returns false so the caller can record the infrastructure failure. No
   * tracker ref means nothing to close.
   */
  async closeTicket(task: TaskRow, comment = `Completed and merged by Harmonic (task ${task.id}).`): Promise<boolean> {
    if (task.trackerRef == null) return true; // native/direct with no ticket — nothing to close
    try {
      const adapter = await this.resolveAdapter(task.workingDir);
      // A freeform tracker may provide inbound facts without status writes.
      // The verified local transition still completes; its next scan remains
      // authoritative if the tracker changes independently.
      if (!adapter.close) return true;
      const { title } = splitTitleBody(task.prompt);
      const ref = { number: task.trackerRef, title, state: 'open' as const };
      // Idempotent close: a ticket already closed (a replayed merging effect, or
      // a re-accept after a prior close) needs no second close — and closing an
      // already-closed issue errors on some trackers (`gh issue close`), which
      // would otherwise report a failure for work that did merge.
      if ((await adapter.readTicket(ref)).state === 'closed') return true;
      await adapter.close(ref, comment);
      return true;
    } catch {
      return false;
    }
  }
}
