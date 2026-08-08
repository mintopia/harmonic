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
   * Clean completion: settle the Run's branch by its Merge Fate. Returns
   * 'escalate' — branch and ticket left for a human — when an auto-merge
   * conflicts or an open-PR can't be created; 'completed' otherwise.
   *
   * open-PR leaves the ticket OPEN: review is off-Harmonic, and the PR's own
   * merge closes the issue. Every other fate (auto-merge, artifact, research,
   * direct mode) fallback-closes — the agent-via-skill normally closes it, so
   * this only fires when the ticket is still open.
   */
  async onCompleted(task: TaskRow, run: RunRow): Promise<'completed' | 'escalate'> {
    if (task.isolationMode === 'worktree' && run.branch && run.baseBranch) {
      const fate = this.mergeFate(task);
      if (fate === 'auto-merge') {
        const merge = await this.git.merge(task.workingDir, run.baseBranch, run.branch);
        if (!merge.ok) return 'escalate';
      } else if (fate === 'open-PR') {
        const adapter = await this.resolveAdapter(task.workingDir);
        if (adapter.openPR) {
          const { title } = splitTitleBody(task.prompt);
          try {
            await adapter.openPR({
              branch: run.branch,
              baseBranch: run.baseBranch,
              title,
              body: `Auto-driven by Harmonic for #${task.trackerRef}.`,
            });
          } catch {
            return 'escalate'; // PR creation failed — don't close the issue over stranded work
          }
          return 'completed'; // the PR is now the review surface; leave the issue for it to close
        }
        // No PR capability: degrade to artifact — leave the branch, fallback-close below.
      }
      // artifact: leave the branch for a human / CI.
    }
    await this.fallbackClose(task).catch(() => {});
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

  /** Close the ticket only if the agent-via-skill didn't already — the "fallback" in fallback-close. */
  private async fallbackClose(task: TaskRow): Promise<void> {
    if (task.trackerRef == null) return;
    const adapter = await this.resolveAdapter(task.workingDir);
    const { title } = splitTitleBody(task.prompt);
    const ticket = await adapter.readTicket({ number: task.trackerRef, title, state: 'open' });
    if (ticket.state === 'closed') return;
    await adapter.close(ticket, 'Resolved by Harmonic (auto-drive).');
  }
}
