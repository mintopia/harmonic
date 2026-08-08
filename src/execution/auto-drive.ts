import type { AppConfig, MergeFate } from '../config.js';
import type { TaskRow, RunRow } from '../db/schema.js';
import { Git } from './git.js';
import { resolveTrackerAdapter, type TrackerAdapter } from '../tracker/adapter.js';

/** research→`/research`, everything else→`/implement` (issue #33). */
export function skillFor(task: Pick<TaskRow, 'wayfinderType'>): string {
  return task.wayfinderType === 'research' ? '/research' : '/implement';
}

/** A mirrored Task's prompt is `title\n\nbody`; recover the two for the Drive Prompt. */
export function splitTitleBody(prompt: string): { title: string; body: string } {
  const i = prompt.indexOf('\n\n');
  return i === -1 ? { title: prompt, body: '' } : { title: prompt.slice(0, i), body: prompt.slice(i + 2) };
}

/** Fill a Drive Prompt template's `{skill}/{ref}/{url}/{title}/{body}` placeholders. */
export function buildDrivePrompt(
  template: string,
  fields: { skill: string; ref: string; url: string; title: string; body: string },
): string {
  return template.replace(/\{(skill|ref|url|title|body)\}/g, (_, key: keyof typeof fields) => fields[key]);
}

/**
 * The auto-drive half of afk mirrored-Task execution (issue #33): the Drive
 * Prompt the Runner injects, and the two runtime decisions it delegates —
 * what becomes of a clean completion (Merge Fate + fallback-close) and whether
 * a failure retries or Escalates. The Runner owns Task/Run state transitions;
 * this class only decides and performs the tracker/git side effects. Absent on
 * a native-only server, where every Run settles the plain way.
 */
export class AutoDrive {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly urlFor: (task: TaskRow) => string | null,
    private readonly resolveAdapter: (repoRoot: string) => Promise<TrackerAdapter> = resolveTrackerAdapter,
    private readonly git = Git,
  ) {}

  /** The auto-driven path: a mirrored Task Harmonic runs unattended. */
  handles(task: TaskRow): boolean {
    return task.origin === 'mirrored' && task.drive === 'afk';
  }

  /** The Drive Prompt for a mirrored afk Task — the global template filled from it. */
  prompt(task: TaskRow): string {
    const { title, body } = splitTitleBody(task.prompt);
    return buildDrivePrompt(this.getConfig().drive.prompt, {
      skill: skillFor(task),
      ref: String(task.trackerRef ?? ''),
      url: this.urlFor(task) ?? '',
      title,
      body,
    });
  }

  /** research is always an artifact; otherwise the global default (per-Task override deferred). */
  private mergeFate(task: TaskRow): MergeFate {
    return task.wayfinderType === 'research' ? 'artifact' : this.getConfig().drive.mergeFate;
  }

  /**
   * A clean harness exit is not success. The success signal is the
   * agent-via-skill having **closed the ticket** — the skills are the source of
   * truth (ADR 0011). So:
   *
   * - **'unresolved'** — the run ended without error but left the ticket open
   *   (e.g. the agent gave up on a missing dependency). The Runner routes this
   *   into the failure path (Auto-Retry within cap, then Escalate); the branch
   *   is **not** merged, so half-done work never lands.
   * - **'escalate'** — an auto-merge conflict or an open-PR that can't be created.
   * - **'completed'** — the agent resolved the ticket; the branch is settled by
   *   Merge Fate. open-PR is the exception: it intentionally leaves the ticket
   *   open (the PR's own merge closes it), so its success is a created PR.
   */
  async onCompleted(task: TaskRow, run: RunRow): Promise<'completed' | 'escalate' | 'unresolved'> {
    const worktree = task.isolationMode === 'worktree' && !!run.branch && !!run.baseBranch;
    const fate = this.mergeFate(task);

    if (worktree && fate === 'open-PR') {
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
        return 'completed'; // the PR is the review surface; it closes the issue
      }
      // No PR capability: degrade to artifact — fall through to the resolved gate.
    }

    // The gate: did the agent actually resolve the ticket?
    if (!(await this.agentResolved(task))) return 'unresolved';

    if (worktree && fate === 'auto-merge') {
      const merge = await this.git.merge(task.workingDir, run.baseBranch!, run.branch!);
      if (!merge.ok) return 'escalate';
    }
    // artifact / direct: nothing to merge; the agent already closed the ticket.
    return 'completed';
  }

  /**
   * A failed afk Run: 'retry' while attempts are within the configured
   * Auto-Retry cap, else 'escalate'. `attempt > autoRetry` exhausts it —
   * default cap 1 means attempt 1 retries, attempt 2 Escalates.
   */
  onFailed(_task: TaskRow, run: RunRow): 'retry' | 'escalate' {
    return run.attempt > this.getConfig().drive.autoRetry ? 'escalate' : 'retry';
  }

  /**
   * The success signal: the agent-via-skill closed the ticket. A run that can't
   * be confirmed closed (read error, or no tracker ref) counts as unresolved —
   * false-completing is worse than an extra retry/escalation.
   */
  private async agentResolved(task: TaskRow): Promise<boolean> {
    if (task.trackerRef == null) return false;
    try {
      const adapter = await this.resolveAdapter(task.workingDir);
      const { title } = splitTitleBody(task.prompt);
      const ticket = await adapter.readTicket({ number: task.trackerRef, title, state: 'open' });
      return ticket.state === 'closed';
    } catch {
      return false;
    }
  }
}
