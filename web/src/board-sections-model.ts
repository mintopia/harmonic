// Explicit .js extensions: this module is shared with the node-side test
// project, whose nodenext resolution requires them (Vite maps .js → .ts).
import type { Task, TaskState } from './types.js';
import type { Epic } from './epic-model.js';

/**
 * The Paper Board's attention-ordered sections (DESIGN.md § 5). The home
 * surface is ordered by the operator's attention:
 * `Needs you → Active → Epics → Standalone`.
 *
 * **Standalone (non-Epic) work is first-class.** A Task is only pulled OUT of
 * the flat sections when it is a member of an *active* Epic — one still in the
 * Landing section — because that Epic's band renders the member itself
 * (DESIGN.md § 5: "an Epic member that is running shows inside its Epic band,
 * not duplicated here"). A member of an already-landed Epic falls back to
 * standalone treatment, so its now-completed Task still surfaces in Recent.
 */

const TERMINAL: readonly TaskState[] = ['completed', 'failed', 'cancelled'];

const PRIORITY_RANK: Record<Task['priority'], number> = { high: 0, normal: 1, low: 2 };

// Queue order mirrors board-model's `byQueueOrder` and the server's
// priority-then-createdAt scheduler sort (src/domain/tasks.ts): highest
// priority first, then the longest-waiting (oldest createdAt) of a priority,
// id ascending as the stable tiebreak.
function byQueueOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || a.id - b.id;
}

// In-flight / Needs-you are processing, not a waiting queue: priority then a
// lowest-id stable tiebreak (mirrors board-model's `byProcessingOrder`).
function byProcessingOrder(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id;
}

// Needs you is the sacred core: an *awaiting-review* Task (the review gate)
// leads an *escalated-only* Task (afk→hitl), then processing order within.
function needsYouRank(t: Task): number {
  return t.state === 'awaiting-review' ? 0 : 1;
}

// Queued tiers so the section reads in the scheduler's reach order (DESIGN.md
// § 5 Queued: "the ready frontier + blocked Tasks … the auto-runner's pick
// order implied"): the ready frontier the runner picks from sits on top, then
// blocked (waiting on a dep), then draft (not yet promoted).
const QUEUED_RANK: Partial<Record<TaskState, number>> = { ready: 0, blocked: 1, draft: 2 };

export interface BoardSections {
  /** Awaiting-review + escalated standalone Tasks — the sacred core, always
   * first, always above the fold (DESIGN.md § 5 Needs you). */
  needsYou: Task[];
  /** Running standalone Tasks; an escalated running Task is promoted to
   * Needs you, and an active-Epic member runs inside its band, not here. */
  active: Task[];
  /** Active Epics, each rendered as a band; ascending by ref. */
  epics: Epic[];
  /** Ready + blocked + draft standalone Tasks, frontier-first. */
  standalone: Task[];
}

/**
 * An Epic belongs in Landing until every member has folded in (and no
 * whole-Epic land is mid-flight). A fully-folded, settled Epic drops off the
 * Deck; its members then revert to standalone Tasks so they surface in Recent.
 * `land.inFlight` keeps a fully-folded Epic visible while its subset is still
 * merging to the default branch.
 */
export function isActiveEpic(epic: Epic): boolean {
  return epic.foldedCount < epic.memberCount || epic.land.inFlight;
}

/** Task ids that are members of an *active* Epic — excluded from the flat
 * sections because their Epic band (Landing) renders them. */
function activeMemberTaskIds(epics: Epic[]): Set<number> {
  const ids = new Set<number>();
  for (const epic of epics) {
    if (!isActiveEpic(epic)) continue;
    for (const m of epic.members) if (m.taskId != null) ids.add(m.taskId);
  }
  return ids;
}

export function boardSections(tasks: Task[], epics: Epic[]): BoardSections {
  const excluded = activeMemberTaskIds(epics);
  const standalone = tasks.filter((t) => !excluded.has(t.id));
  const isTerminal = (t: Task): boolean => TERMINAL.includes(t.state);

  const needsYou = standalone
    .filter((t) => !isTerminal(t) && (t.state === 'awaiting-review' || t.escalated))
    .sort((a, b) => needsYouRank(a) - needsYouRank(b) || byProcessingOrder(a, b));

  const active = standalone.filter((t) => t.state === 'running' && !t.escalated).sort(byProcessingOrder);

  const standaloneTasks = standalone
    .filter((t) => !t.escalated && QUEUED_RANK[t.state] !== undefined)
    .sort((a, b) => QUEUED_RANK[a.state]! - QUEUED_RANK[b.state]! || byQueueOrder(a, b));

  const activeEpics = epics.filter(isActiveEpic).sort((a, b) => a.ref - b.ref);

  return { needsYou, active, epics: activeEpics, standalone: standaloneTasks };
}

/** Elapsed as "1h 2m" / "3m 4s" / "5s" for live Board cards. */
export function fmtElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function runningReadout(task: Task, now: number, liveTools?: number | null): { elapsed: string; tools: number } | null {
  if (task.state !== 'running' || task.runStartedAt === null) return null;
  return { elapsed: fmtElapsed(Math.max(0, now - task.runStartedAt)), tools: liveTools ?? task.toolCount ?? 0 };
}
