import { type AppConfig, type MergeFate } from '../config.js';
import type { TaskRow, RunRow } from '../db/schema.js';
import { resolveTrackerAdapter, type TrackerAdapter } from '../tracker/adapter.js';
import { driveFields, fillTemplate, splitTitleBody } from './prompt-template.js';

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
  ) {}

  /** The auto-driven path: a mirrored Task Harmonic runs unattended. */
  handles(task: TaskRow): boolean {
    return task.origin === 'mirrored' && task.drive === 'afk';
  }

  /** The Drive Prompt for a mirrored afk Task — the global template filled from it. */
  prompt(task: TaskRow): string {
    const drive = fillTemplate(this.getConfig().drive.prompt, driveFields(task, this.urlFor));
    // A re-queued mirrored Task carries operator feedback in its column (the
    // prompt is re-derived from the ticket each poll). Append it so the retry
    // sees it — same section the native review/re-attempt path uses (run-prompt.ts).
    const feedback = task.feedback?.trim();
    const withFeedback = feedback ? `${drive}\n\n## Feedback from the previous attempt\n\n${feedback}` : drive;
    return `${withFeedback}\n\n${this.unattendedReminder(task)}`;
  }

  /** The operator-editable unattended reminder with this Task's id filled in (initial + continue). */
  private unattendedReminder(task: TaskRow): string {
    return this.getConfig().drive.unattendedReminder.replace(/\{taskId\}/g, String(task.id));
  }

  /**
   * Re-prompt for a Run that ended its turn without finishing or escalating.
   * Nudges the agent to resume rather than idle-wait, and re-states the
   * unattended reminder (working memory is short across turns).
   */
  continuePrompt(task: TaskRow): string {
    const nudge = this.getConfig().drive.continuePrompt.replace(/\{taskId\}/g, String(task.id));
    return `${nudge}\n\n${this.unattendedReminder(task)}`;
  }

  /** How many times to re-prompt an unfinished Run before treating it as unresolved. */
  continueAttempts(): number {
    return this.getConfig().drive.continueAttempts;
  }

  /** research is always an artifact; otherwise the global default (per-Task override deferred). */
  private mergeFate(task: TaskRow): MergeFate {
    return task.wayfinderType === 'research' ? 'artifact' : this.getConfig().drive.mergeFate;
  }

  /**
   * The Merge Fate for a Task, exposed so the Runner can gate deterministic
   * recovery landing (issue #154) on the **same** fate this class applies — a
   * direct-mode Run only lands its reconstructed candidate onto the intended
   * branch when the fate is `auto-merge`; `open-PR`/`artifact` leave the branch
   * untouched (the work stays on the candidate/private ref). Single source of
   * truth so recovery landing never diverges from `onCompleted`'s fate.
   */
  mergeFateFor(task: TaskRow): MergeFate {
    return this.mergeFate(task);
  }

  /**
   * Land a passing afk Run's work per its Merge Fate — the close-after-verify
   * model (issue #139, ADR-0021, reliability-design Unit B). The
   * execution-complete signal is the agent's `finish_task` (the Runner's
   * `agentFinished` gate), **not** the agent closing the ticket: under this
   * model Harmonic itself owns the close, and only after verify + land. So this
   * never gates on the ticket state — it closes where the fate says:
   *
   * - **auto-merge** — the Runner has already landed the verified tip (its
   *   landing freshness gate, ADR-0041; the merge train for Epic members), so
   *   Harmonic closes the ticket. A close that fails Escalates (a human finishes
   *   the close, the work is safe).
   * - **open-PR** — open a PR and leave the ticket **open**: creating a PR is not
   *   landing, so the PR's own merge closes the issue later. A PR that can't be
   *   created Escalates. A tracker with no PR support degrades to artifact.
   * - **artifact** (incl. research) — leave the branch and the ticket untouched;
   *   no merge, no close.
   *
   * Returns `'completed'` once the fate has landed, or `'escalate'` when it
   * could not be applied. Unlike the pre-#139 model there is no `'unresolved'`
   * outcome here — a Run with no `finish_task` signal never reaches this method
   * (the Runner routes it to the failure path before verification).
   */
  async onCompleted(task: TaskRow, run: RunRow): Promise<'completed' | 'escalate'> {
    const worktree = task.isolationMode === 'worktree' && !!run.branch && !!run.baseBranch;
    const fate = this.mergeFate(task);

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
      // The Runner has already landed the verified tip (SHA-asserted, ADR-0041);
      // Harmonic owns the close (issue #139).
      return (await this.closeTicket(task)) ? 'completed' : 'escalate';
    }

    // artifact (incl. research): leave the branch and the ticket untouched.
    return 'completed';
  }

  /**
   * The auto-merge close step, split out so the merge-train landing path (issue
   * #163) can reuse it: an Epic member's Run lands its branch onto the Epic
   * integration branch through the {@link MergeTrainCoordinator} (fast-forward of the verified tip)
   * rather than {@link onCompleted}'s plain `git.merge`, but the close-after-land
   * half is identical — Harmonic owns the close (#139), only after a successful
   * land. Returns whether the close was issued (false ⇒ the caller Escalates).
   */
  async closeCompleted(task: TaskRow): Promise<boolean> {
    return this.closeTicket(task);
  }

  /**
   * Close the Task's ticket as the final auto-merge landing step (issue #139) —
   * Harmonic, not the agent, owns the close, and only reaches here after verify
   * + a successful land. Returns whether the close was issued; a read/write
   * failure (or no tracker ref) returns false so the Runner Escalates rather
   * than reporting a completion whose close never landed.
   */
  private async closeTicket(task: TaskRow): Promise<boolean> {
    if (task.trackerRef == null) return true; // native/direct with no ticket — nothing to close
    try {
      const adapter = await this.resolveAdapter(task.workingDir);
      // A freeform tracker may provide inbound facts without status writes.
      // The verified local transition still completes; its next scan remains
      // authoritative if the tracker changes independently.
      if (!adapter.close) return true;
      const { title } = splitTitleBody(task.prompt);
      const ref = { number: task.trackerRef, title, state: 'open' as const };
      // Idempotent close: a ticket already closed (a replayed landing effect, or
      // a re-accept after a prior close) needs no second close — and closing an
      // already-closed issue errors on some trackers (`gh issue close`), which
      // would otherwise report failure and repark the accept for review in a loop.
      if ((await adapter.readTicket(ref)).state === 'closed') return true;
      await adapter.close(ref, `Completed and landed by Harmonic (task ${task.id}).`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-open a Task's ticket that was closed before Harmonic landed it (issue
   * #139): under the close-after-verify model only Harmonic closes a ticket, so
   * a close it did not make (agent-via-skill, or an operator) is premature —
   * revert it so a closed ticket never stands in for verified, landed work.
   * Best-effort: returns whether the reopen was issued.
   */
  async reopenTicket(task: TaskRow): Promise<boolean> {
    if (task.trackerRef == null) return false;
    try {
      const adapter = await this.resolveAdapter(task.workingDir);
      if (!adapter.reopen) return false;
      const { title } = splitTitleBody(task.prompt);
      await adapter.reopen(
        { number: task.trackerRef, title, state: 'closed' },
        `Reopened by Harmonic: the ticket was closed before verification and landing completed (task ${task.id}).`,
      );
      return true;
    } catch {
      return false;
    }
  }
}
